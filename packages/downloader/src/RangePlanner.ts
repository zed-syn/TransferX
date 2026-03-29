/**
 * @module RangePlanner
 *
 * Splits a known file size into non-overlapping, contiguous byte ranges.
 *
 * Design decisions:
 *   - Chunk sizes are uniform; the last chunk absorbs any remainder.
 *   - Minimum chunk size is clamped to 1 MiB to avoid degenerate splits
 *     on tiny files with large concurrency settings.
 *   - If the file size is unknown (no Content-Length) the planner returns
 *     a single "full-file" chunk (start=0, end=Infinity equivalent — handled
 *     downstream by the downloader as a streaming single-connection download).
 *   - Can rebuild a partial plan from persisted state, skipping already-done
 *     chunks — this is the resume path.
 */

import type { ChunkMeta } from "./types.js";

const MIN_CHUNK_SIZE = 1 * 1024 * 1024; // 1 MiB

export class RangePlanner {
  /**
   * Plan a fresh download.
   *
   * @param fileSize     Total byte count, or null if unknown.
   * @param chunkSize    Desired bytes per chunk (will be clamped to ≥ 1 MiB).
   * @param supportsRange Whether the server supports HTTP range requests.
   */
  static plan(
    fileSize: number | null,
    chunkSize: number,
    supportsRange: boolean,
  ): ChunkMeta[] {
    // Single-stream fallback: unknown size or range not supported.
    // end = -1 is the sentinel meaning "stream to EOF" — the engine must
    // NOT send a Range header for this chunk. size = 0 means unknown.
    if (!supportsRange || fileSize === null) {
      return [
        {
          index: 0,
          start: 0,
          end: -1,
          size: 0,
          status: "pending",
          attempts: 0,
          bytesWritten: 0,
        },
      ];
    }

    const effectiveChunkSize = Math.max(MIN_CHUNK_SIZE, chunkSize);
    const chunks: ChunkMeta[] = [];
    let offset = 0;
    let index = 0;

    while (offset < fileSize) {
      const end = Math.min(offset + effectiveChunkSize - 1, fileSize - 1);
      chunks.push(RangePlanner._chunk(index, offset, end, fileSize));
      offset = end + 1;
      index++;
    }

    return chunks;
  }

  /**
   * Rebuild the chunk plan from a persisted session.
   * Already-'done' chunks are kept as-is.
   * Chunks in 'running' state (crashed mid-flight) are reset to 'pending'
   * — we don't know how many bytes actually landed on disk.
   */
  static rehydrate(chunks: ChunkMeta[]): ChunkMeta[] {
    return chunks.map((c) => {
      if (c.status === "running" || c.status === "failed") {
        // Preserve bytesWritten for byte-level sub-chunk resume.
        //
        // DownloadEngine will resume from:
        //   Range: bytes=(chunk.start + safeOffset)-(chunk.end)
        // where safeOffset = floor(bytesWritten / RESUME_GRANULARITY) * RESUME_GRANULARITY
        // (conservative 1 MiB round-down to handle kernel write-back uncertainty).
        //
        // pwrite semantics guarantee that re-writing already-written bytes is
        // safe and idempotent — no corruption can occur.
        return { ...c, status: "pending", attempts: 0 };
        // NOTE: bytesWritten intentionally preserved (was reset to 0 before v1.2.0)
      }
      return { ...c };
    });
  }

  /** Returns only chunks that still need work. */
  static pendingChunks(chunks: ChunkMeta[]): ChunkMeta[] {
    return chunks.filter(
      (c) => c.status === "pending" || c.status === "failed",
    );
  }

  /**
   * True when the chunk represents a full-stream download (no Range header).
   * This is the case when the server did not advertise range support or the
   * file size was unknown. Indicated by end === -1.
   */
  static isStreamingChunk(chunk: ChunkMeta): boolean {
    return chunk.end === -1;
  }

  private static _chunk(
    index: number,
    start: number,
    end: number,
    fileSize: number,
  ): ChunkMeta {
    return {
      index,
      start,
      end,
      size: fileSize > 0 ? end - start + 1 : 0,
      status: "pending",
      attempts: 0,
      bytesWritten: 0,
    };
  }
}
