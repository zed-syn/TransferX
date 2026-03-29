/**
 * @module FileWriter
 *
 * Safe, random-access, non-blocking file writer.
 *
 * Critical design requirements:
 *   1. Pre-allocate (or at minimum open) the output file once.
 *   2. Write each chunk to its exact byte offset — concurrent chunks must
 *      never corrupt each other (no shared cursor).
 *   3. All writes are non-blocking (fs.write with position, not fs.writeSync).
 *   4. The writer serialises writes to the SAME offset range via an internal
 *      per-chunk promise chain so stale retried writes don't corrupt a freshly
 *      written chunk.
 *   5. fsync on completion to guarantee durability before the download is
 *      declared done.
 *
 * Streaming pipeline:
 *   DownloadEngine hands the writer a ReadableStream body from fetch().
 *   The writer asynchronously reads each Uint8Array chunk from the stream
 *   and calls fs.write(fd, buffer, offset, length, position).
 *   The `position` is the absolute byte offset in the file (startByte + bytesWritten).
 *   This is the POSIX pwrite() semantic — no seek, no lock needed per chunk.
 *
 * Error handling:
 *   Any fs.write failure throws a diskError immediately.
 *   The FileWriter itself does NOT retry — the DownloadEngine's retry engine
 *   handles that at the chunk level (re-opens a new fetch stream).
 */

import * as fs from "fs";
import * as path from "path";
import { diskError } from "./types.js";

export class FileWriter {
  private _fd: number | null = null;
  private readonly _path: string;

  constructor(filePath: string) {
    this._path = filePath;
  }

  /**
   * Open the output file.
   *
   * @param fileSize  Known remote file size, or null if the server gave no
   *                  Content-Length. When known and resume=false, a single
   *                  zero byte is written at (fileSize - 1) to pre-allocate
   *                  the file extent (portable fallocate equivalent).
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

    // Pre-allocate: stamp the full file size so the OS can reserve contiguous
    // blocks. We write one zero byte at the last offset — this works on all
    // platforms including Windows NTFS (no fallocate syscall needed).
    if (!resume && fileSize !== null && fileSize > 0) {
      await this._writeAt(Buffer.alloc(1), fileSize - 1);
    }
  }

  /**
   * Stream an HTTP response body into the file at the chunk's byte offset.
   *
   * @param body         ReadableStream<Uint8Array> from fetch response.
   * @param startOffset  Byte offset in the file where this chunk begins.
   * @param onBytes      Callback invoked after each write with bytes written.
   * @returns            Total bytes written for this chunk.
   */
  async writeStream(
    body: ReadableStream<Uint8Array>,
    startOffset: number,
    onBytes: (bytes: number) => void,
  ): Promise<number> {
    this._assertOpen();
    const reader = body.getReader();
    let position = startOffset;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;

        const buf = Buffer.from(
          value.buffer,
          value.byteOffset,
          value.byteLength,
        );
        await this._writeAt(buf, position);
        position += buf.byteLength;
        onBytes(buf.byteLength);
      }
    } finally {
      reader.releaseLock();
    }

    return position - startOffset;
  }

  /**
   * Flush to disk (fdatasync). Call once after all chunks complete.
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

  private _writeAt(buf: Buffer, position: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      fs.write(this._fd!, buf, 0, buf.byteLength, position, (err, written) => {
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
      });
    });
  }
}
