/**
 * @module types/chunk
 *
 * ChunkMeta describes a single slice of a file to be transferred.
 *
 * Invariants:
 *   - index >= 0
 *   - offset >= 0
 *   - size > 0
 *   - offset + size <= totalSize
 *   - checksum is set only after the chunk has been read/verified
 */

// ── Chunk lifecycle ──────────────────────────────────────────────────────────

/**
 * Every state a single chunk passes through.
 *
 * Transitions:
 *   pending  → uploading  (scheduler picks it up)
 *   uploading → done      (server confirms)
 *   uploading → failed    (network / server error)
 *   failed    → pending   (retry engine re-queues it)
 *   failed    → fatal     (retry budget exhausted)
 */
export type ChunkStatus =
  | "pending" // waiting to be scheduled
  | "uploading" // in-flight
  | "done" // server confirmed receipt
  | "failed" // last attempt failed, will be retried
  | "fatal"; // retry budget exhausted — terminal

export interface ChunkMeta {
  /** Zero-based sequential index within the session. */
  readonly index: number;
  /** Byte offset within the source file. */
  readonly offset: number;
  /** Byte length of this chunk (<= chunkSize, possibly smaller for last chunk). */
  readonly size: number;
  /** Current lifecycle state. */
  status: ChunkStatus;
  /** How many upload attempts have been made so far. */
  attempts: number;
  /**
   * Opaque provider token returned by the adapter after a successful upload.
   * Used by multi-part completion calls (e.g. B2 partSha1, S3 ETag).
   */
  providerToken?: string;
  /** SHA-256 hex digest — populated after the chunk data is read. */
  checksum?: string;
  /** Epoch ms of the last failed attempt, for backoff calculation. */
  lastFailedAt?: number;
  /** Last error message for observability. */
  lastError?: string;
}

// ── Factory ─────────────────────────────────────────────────────────────────

/** Build an initial pending ChunkMeta. Pure function — no side effects. */
export function makeChunkMeta(
  index: number,
  offset: number,
  size: number,
): ChunkMeta {
  if (index < 0) throw new RangeError(`chunk index must be >= 0, got ${index}`);
  if (offset < 0)
    throw new RangeError(`chunk offset must be >= 0, got ${offset}`);
  if (size <= 0) throw new RangeError(`chunk size must be > 0, got ${size}`);
  return { index, offset, size, status: "pending", attempts: 0 };
}
