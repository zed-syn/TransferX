/**
 * @module FileWriter
 *
 * Safe, random-access, non-blocking file writer.
 *
 * Critical design requirements:
 *   1. Pre-allocate the output file with ftruncate() so the OS can reserve
 *      contiguous extents (better sequential-read performance post-download).
 *   2. Write each chunk to its exact byte offset — concurrent chunks must
 *      never corrupt each other (no shared cursor).
 *   3. All writes are non-blocking (fs.write with position, not fs.writeSync).
 *   4. Periodic fdatasync via syncOnChunkComplete() — bounds data loss on
 *      power failure to at most N×chunkSize bytes instead of the entire file.
 *   5. Final fdatasync at completion (flush()) before the session is deleted.
 *
 * Streaming pipeline:
 *   DownloadEngine hands the writer a ReadableStream body from fetch().
 *   When a BufferPool is supplied, small stream frames are coalesced into
 *   256 KiB writes, reducing fs.write() syscall count and GC allocations.
 *   Without a pool the behaviour is backward-compatible (one write per frame).
 *   The `position` passed to fs.write() is the POSIX pwrite() semantic —
 *   no seek or lock needed across parallel chunks.
 *
 * Error handling:
 *   Any fs.write failure throws a diskError immediately.
 *   FileWriter does NOT retry — DownloadEngine's retry engine handles that.
 */

import * as fs from "fs";
import * as path from "path";
import { diskError } from "./types.js";
import type { BufferPool } from "./BufferPool.js";

export class FileWriter {
  private _fd: number | null = null;
  private readonly _path: string;
  /** Internal counter for batched periodic sync. */
  private _chunksSinceSync: number = 0;

  constructor(filePath: string) {
    this._path = filePath;
  }

  /**
   * Open the output file.
   *
   * @param fileSize  Known remote file size, or null if the server gave no
   *                  Content-Length. When known and resume=false, ftruncate()
   *                  pre-allocates the full extent so the OS can reserve
   *                  contiguous disk blocks.
   * @param resume    true  → open existing file with 'r+' (preserve bytes).
   *                  false → open/create with 'w' (truncates any existing
   *                          file, guaranteeing no stale trailing bytes from
   *                          a previous, different download at the same path).
   */
  async open(fileSize: number | null, resume: boolean): Promise<void> {
    await fs.promises.mkdir(path.dirname(this._path), { recursive: true });

    // 'w'  — creates if absent, truncates to 0 if present  (fresh start)
    // 'r+' — fails if absent, preserves content            (resume)
    const flag = resume ? "r+" : "w";

    this._fd = await new Promise<number>((resolve, reject) => {
      fs.open(this._path, flag, (err, fd) => {
        if (err)
          reject(diskError(`Cannot open ${this._path}: ${err.message}`, err));
        else resolve(fd);
      });
    });

    // Pre-allocate: ftruncate() extends the file to fileSize bytes in a
    // single syscall. On ext4/NTFS this typically results in a contiguous
    // allocation, improving sequential-read performance of the finished file.
    // It is strictly superior to the previous single-byte-stamp approach.
    if (!resume && fileSize !== null && fileSize > 0) {
      await new Promise<void>((resolve, reject) => {
        fs.ftruncate(this._fd!, fileSize, (err) => {
          if (err)
            reject(
              diskError(`ftruncate(${fileSize}) failed: ${err.message}`, err),
            );
          else resolve();
        });
      });
    }
  }

  /**
   * Stream an HTTP response body into the file at the chunk's byte offset.
   *
   * @param body         ReadableStream<Uint8Array> from fetch response.
   * @param startOffset  Byte offset in the file where this chunk begins.
   *                     For byte-level resume this is chunk.start + resumeBytes.
   * @param onBytes      Callback invoked after each flush with bytes written.
   * @param pool         Optional BufferPool for write-coalescing. When provided,
   *                     small stream frames are accumulated into a 256 KiB buffer
   *                     before calling fs.write(), reducing syscall overhead
   *                     and per-frame Buffer allocations.
   * @returns            Total bytes written for this invocation.
   */
  async writeStream(
    body: ReadableStream<Uint8Array>,
    startOffset: number,
    onBytes: (bytes: number) => void,
    pool?: BufferPool,
  ): Promise<number> {
    this._assertOpen();
    const reader = body.getReader();
    let filePosition = startOffset;
    let totalWritten = 0;

    // Coalesce mode: accumulate frames into a reusable pool buffer to reduce
    // the number of fs.write() calls and eliminate per-frame allocations.
    let coalesceBuf: Buffer | null = pool ? pool.acquire() : null;
    let coalesceFill = 0;

    const flushCoalesce = async (): Promise<void> => {
      if (coalesceBuf && coalesceFill > 0) {
        // subarray() creates a view — fs.write() reads the bytes synchronously
        // before the callback fires, so reusing the buffer after await is safe.
        await this._writeAt(
          coalesceBuf.subarray(0, coalesceFill),
          filePosition,
        );
        filePosition += coalesceFill;
        onBytes(coalesceFill);
        totalWritten += coalesceFill;
        coalesceFill = 0;
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;

        if (coalesceBuf && pool) {
          // Copy stream frames into the coalesce buffer; flush when full.
          let srcPos = 0;
          const poolSize = pool.bufferSize;
          while (srcPos < value.byteLength) {
            const space = poolSize - coalesceFill;
            const toCopy = Math.min(space, value.byteLength - srcPos);
            coalesceBuf.set(
              value.subarray(srcPos, srcPos + toCopy),
              coalesceFill,
            );
            coalesceFill += toCopy;
            srcPos += toCopy;
            if (coalesceFill === poolSize) {
              await flushCoalesce();
            }
          }
        } else {
          // No pool: direct write per frame (backward-compatible path).
          const buf = Buffer.from(
            value.buffer,
            value.byteOffset,
            value.byteLength,
          );
          await this._writeAt(buf, filePosition);
          const n = buf.byteLength;
          filePosition += n;
          onBytes(n);
          totalWritten += n;
        }
      }

      // Flush any remaining coalesced bytes.
      await flushCoalesce();
    } finally {
      reader.releaseLock();
      if (coalesceBuf && pool) {
        pool.release(coalesceBuf);
      }
    }

    return totalWritten;
  }

  /**
   * Flush to disk (fdatasync). Blocks until all previously written bytes
   * are guaranteed to be on stable storage.
   *
   * Called:
   *   1. Periodically via syncOnChunkComplete() for crash durability.
   *   2. Once at download completion before the session is deleted.
   */
  async flush(): Promise<void> {
    this._assertOpen();
    await new Promise<void>((resolve, reject) => {
      fs.fdatasync(this._fd!, (err) => {
        if (err) reject(diskError(`fdatasync failed: ${err.message}`, err));
        else resolve();
      });
    });
  }

  /**
   * Increment the completed-chunk counter and call flush() (fdatasync)
   * whenever the counter reaches `intervalChunks`.
   *
   * This bounds data loss on hard power failure to at most
   * intervalChunks × chunkSize bytes of completed work, while amortising
   * the fdatasync cost across multiple chunks.
   *
   * @param intervalChunks  Flush every N chunks. 0 = no-op (skip). Default: 8.
   */
  async syncOnChunkComplete(intervalChunks: number = 8): Promise<void> {
    if (intervalChunks <= 0) return;
    this._chunksSinceSync++;
    if (this._chunksSinceSync >= intervalChunks) {
      this._chunksSinceSync = 0;
      await this.flush();
    }
  }

  /** Close the file descriptor. Safe to call multiple times. */
  async close(): Promise<void> {
    if (this._fd === null) return;
    const fd = this._fd;
    this._fd = null;
    await new Promise<void>((resolve, reject) => {
      fs.close(fd, (err) => {
        if (err) reject(diskError(`close failed: ${err.message}`, err));
        else resolve();
      });
    });
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private _assertOpen(): void {
    if (this._fd === null) {
      throw diskError("FileWriter is not open. Call open() first.");
    }
  }

  private _writeAt(buf: Buffer | Uint8Array, position: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      fs.write(
        this._fd!,
        buf as Buffer,
        0,
        buf.byteLength,
        position,
        (err, written) => {
          if (err) {
            reject(
              diskError(
                `Write failed at offset ${position}: ${err.message}`,
                err,
              ),
            );
          } else if (written !== buf.byteLength) {
            reject(
              diskError(
                `Short write at offset ${position}: expected ${buf.byteLength}, got ${written}`,
              ),
            );
          } else {
            resolve();
          }
        },
      );
    });
  }
}
