/**
 * @module adapter/ITransferAdapter
 *
 * The pluggable storage backend contract.
 *
 * The UploadEngine drives the transfer lifecycle and calls into the adapter
 * at specific points.  Adapters must implement all methods on this interface
 * to be usable with the engine.
 *
 * Design decisions:
 *
 * 1. MINIMAL SURFACE AREA:
 *    The interface contains only what the engine actually needs.
 *    Adapter-specific concepts (e.g. B2's large-file API, S3's MPU) are
 *    hidden inside the adapter implementation.
 *
 * 2. SESSION-ORIENTED:
 *    Each adapter instance is stateless with respect to sessions.
 *    The engine creates a new "remote session" via `initTransfer` and
 *    passes its id back on every subsequent call.  This lets the adapter
 *    stay simple (no Map<sessionId, …> inside it).
 *
 * 3. TYPED ERRORS:
 *    Adapters MUST throw TransferError — not raw HTTP errors.
 *    Mapping HTTP status codes → ErrorCategory is the adapter's job.
 *    The engine never sees raw HTTP errors; it only acts on ErrorCategory.
 *
 * 4. IDEMPOTENT CHUNK UPLOADS:
 *    `uploadChunk` may be called multiple times for the same chunk (retries).
 *    Adapters should be idempotent or detect/overwrite duplicates naturally
 *    (e.g. B2 upload-part is idempotent given the same partNumber).
 *
 * 5. CHECKSUM CONTRACT:
 *    `uploadChunk` receives the pre-computed SHA-256 hex of the chunk data.
 *    Adapters should pass this to the provider for server-side verification
 *    (B2 requires it; S3 supports content-MD5/SHA256).
 */

import type { ChunkMeta } from "../types/chunk.js";
import type { TransferSession } from "../types/session.js";

// ── Per-chunk upload result ───────────────────────────────────────────────────

/**
 * Returned by `uploadChunk`.
 * `providerToken` is an opaque per-chunk identifier used in `completeTransfer`.
 * For B2 it is the SHA-1 of the part; for S3 it is the ETag.
 */
export interface ChunkUploadResult {
  providerToken: string;
}

// ── The adapter contract ──────────────────────────────────────────────────────

export interface ITransferAdapter {
  /**
   * Start a new multi-part transfer on the provider.
   *
   * Called once per session, before any chunk is uploaded.
   *
   * @param session  - The session that is starting. Use `session.file` for
   *                   file metadata and `session.targetKey` for the remote path.
   * @returns          The provider-assigned session identifier, stored in
   *                   `session.providerSessionId`.
   */
  initTransfer(session: TransferSession): Promise<string>;

  /**
   * Upload a single chunk of bytes to the provider.
   *
   * @param session       - The owning session (for targetKey, providerSessionId …)
   * @param chunk         - Metadata for this chunk (index, offset, size).
   * @param data          - The raw bytes to upload.
   * @param sha256Hex     - Pre-computed SHA-256 hex digest of `data`.
   * @returns               Resolved per-chunk result that will be stored in
   *                        `chunk.providerToken` and passed to `completeTransfer`.
   */
  uploadChunk(
    session: TransferSession,
    chunk: ChunkMeta,
    data: Uint8Array,
    sha256Hex: string,
  ): Promise<ChunkUploadResult>;

  /**
   * Finalise the transfer after all chunks are uploaded.
   * For B2 this calls `b2_finish_large_file`; for S3 it calls `CompleteMultipartUpload`.
   *
   * @param session  - Session whose all chunks are in `done` state.
   * @param chunks   - All chunks with their `providerToken` values populated.
   */
  completeTransfer(
    session: TransferSession,
    chunks: ChunkMeta[],
  ): Promise<void>;

  /**
   * Abort an in-progress transfer on the provider side.
   * Called when a session transitions to `cancelled` or `failed`.
   * Should be a best-effort: do not throw if the remote session is already gone.
   *
   * @param session  - The session to abort.
   */
  abortTransfer(session: TransferSession): Promise<void>;

  /**
   * Optional: query the provider for the list of already-uploaded parts.
   *
   * Used during resume reconciliation to determine which chunks the provider
   * already has, so the engine can skip re-uploading them.
   *
   * If not implemented by the adapter, the engine falls back to trusting
   * local state alone (chunks with status === 'done' are assumed confirmed).
   *
   * @param session  - The session to query; `session.providerSessionId` is set.
   * @returns        - Uploaded parts in provider order (partNumber is 1-based).
   */
  getRemoteState?(session: TransferSession): Promise<RemoteUploadState>;
}

// ── Remote state ─────────────────────────────────────────────────────────────

/**
 * Snapshot of what the provider already has for a multi-part upload.
 * Returned by `getRemoteState()`.
 */
export interface RemoteUploadState {
  uploadedParts: Array<{
    /** 1-based part number (chunk.index + 1). */
    partNumber: number;
    /** Provider token (ETag for S3, SHA-1 for B2). */
    providerToken: string;
  }>;
}
