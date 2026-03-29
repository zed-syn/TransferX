/**
 * @module chunker/Chunker
 *
 * Responsible for splitting a file into an ordered list of ChunkMeta records.
 *
 * Design decisions:
 *   - Pure function surface: no I/O, no side effects.
 *     Reading raw bytes is done by the engine layer (IChunkReader).
 *   - Handles all edge cases explicitly:
 *       - empty files           → 0 chunks (valid; adapter must handle)
 *       - single-byte files     → 1 chunk of size 1
 *       - exact multiples       → no zero-length tail chunk
 *       - non-multiples         → last chunk is smaller than chunkSize
 *   - chunkSize minimum is enforced here, not in config, to isolate the
 *     policy from the mechanism.
 */

import { makeChunkMeta } from "../types/chunk.js";
import type { ChunkMeta } from "../types/chunk.js";

export const MIN_CHUNK_SIZE = 1; // internal: allow any size; adapters enforce B2/S3 minimums

/**
 * Compute the ordered list of ChunkMeta for a file.
 *
 * @param fileSize   - Total byte length of the file.
 * @param chunkSize  - Target byte length per chunk (must be > 0).
 * @returns          - Array of ChunkMeta, in ascending offset order.
 *
 * @throws RangeError if fileSize < 0 or chunkSize < MIN_CHUNK_SIZE.
 */
export function computeChunks(
  fileSize: number,
  chunkSize: number,
): ChunkMeta[] {
  if (!Number.isInteger(fileSize) || fileSize < 0) {
    throw new RangeError(
      `fileSize must be a non-negative integer, got ${fileSize}`,
    );
  }
  if (!Number.isInteger(chunkSize) || chunkSize < MIN_CHUNK_SIZE) {
    throw new RangeError(
      `chunkSize must be >= ${MIN_CHUNK_SIZE}, got ${chunkSize}`,
    );
  }

  // Empty file: zero chunks.
  // The engine/adapter must handle this (e.g. use a zero-byte PUT).
  if (fileSize === 0) return [];

  const chunks: ChunkMeta[] = [];
  let offset = 0;
  let index = 0;

  while (offset < fileSize) {
    const remaining = fileSize - offset;
    const size = Math.min(chunkSize, remaining);
    chunks.push(makeChunkMeta(index, offset, size));
    offset += size;
    index += 1;
  }

  return chunks;
}

/**
 * Validate that a pre-existing chunk list is consistent with the given file.
 * Used during resume to ensure stored state matches actual file metadata.
 *
 * @throws Error with a descriptive message on any inconsistency.
 */
export function validateChunks(
  chunks: ChunkMeta[],
  fileSize: number,
  chunkSize: number,
): void {
  const expected = computeChunks(fileSize, chunkSize);

  if (chunks.length !== expected.length) {
    throw new Error(
      `Chunk count mismatch: stored=${chunks.length}, recomputed=${expected.length} ` +
        `(fileSize=${fileSize}, chunkSize=${chunkSize})`,
    );
  }

  for (let i = 0; i < expected.length; i++) {
    const got = chunks[i]!;
    const want = expected[i]!;

    if (
      got.index !== want.index ||
      got.offset !== want.offset ||
      got.size !== want.size
    ) {
      throw new Error(
        `Chunk ${i} geometry mismatch: ` +
          `stored={index:${got.index},offset:${got.offset},size:${got.size}} ` +
          `expected={index:${want.index},offset:${want.offset},size:${want.size}}`,
      );
    }
  }
}

// ── Smart chunk sizing ────────────────────────────────────────────────────────

/**
 * Recommend an optimal chunk size for a given file size.
 *
 * Balances two competing concerns:
 *   1. Minimise the total number of parts (each part = one HTTP round trip with
 *      overhead). B2 and S3 both support up to 10,000 parts; large files with
 *      tiny chunks exhaust this.
 *   2. Keep individual chunks small enough whose retry cost doesn't dominate.
 *      A 500 MiB chunk that fails at byte 499 must be re-sent in full.
 *
 * The returned sizes meet the B2/S3 minimum part size (5 MiB) except when
 * explicitly overriding for tests (see `overrides`).
 *
 * | File size     | Chunk size | Max parts (at this size) |
 * |---------------|------------|--------------------------|
 * | < 100 MiB     | 5 MiB      | 20                       |
 * | 100 MiB–1 GiB | 10 MiB     | 102                      |
 * | 1 GiB–10 GiB  | 25 MiB     | 410                      |
 * | > 10 GiB      | 50 MiB     | up to 2,048 (per 100 GiB)|
 *
 * @param fileSizeBytes  - Total size of the file in bytes.
 * @returns                Recommended chunk size in bytes.
 */
export function recommendChunkSize(fileSizeBytes: number): number {
  const MiB = 1024 * 1024;
  if (fileSizeBytes < 100 * MiB) return 5 * MiB; // < 100 MiB
  if (fileSizeBytes < 1024 * MiB) return 10 * MiB; // 100 MiB – 1 GiB
  if (fileSizeBytes < 10 * 1024 * MiB) return 25 * MiB; // 1 GiB – 10 GiB
  return 50 * MiB; // ≥ 10 GiB
}

// ── IChunkReader — platform-agnostic chunk data access ───────────────────────

/**
 * Implemented by the host environment:
 *   - Node: reads from a file descriptor / stream
 *   - Browser: reads from a File/Blob slice
 */
export interface IChunkReader {
  /**
   * Read [offset, offset+size) bytes and return them as a Uint8Array.
   * Must resolve with exactly `size` bytes unless at EOF.
   * Must reject on I/O errors.
   */
  read(offset: number, size: number): Promise<Uint8Array>;

  /** Release any underlying resources (file handles etc.). */
  close(): Promise<void>;
}
