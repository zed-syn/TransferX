/**
 * @module adapter-http
 *
 * Generic callback-based HTTP adapter for TransferX.
 *
 * Unlike the B2 and S3 adapters that hard-code a specific provider's API, this
 * adapter delegates every lifecycle step to caller-provided async functions.
 * This makes it suitable for any custom HTTP multipart upload endpoint without
 * requiring a dedicated adapter package.
 *
 * Usage:
 * ```ts
 * import { createHttpAdapter } from "@transferx/adapter-http";
 *
 * const adapter = createHttpAdapter({
 *   initFn: async (session) => {
 *     const res = await fetch("/api/upload/init", { method: "POST", body: JSON.stringify({ name: session.targetKey }) });
 *     const { uploadId } = await res.json();
 *     return uploadId;
 *   },
 *   uploadFn: async (session, chunk, data, sha256Hex) => {
 *     const res = await fetch(`/api/upload/${session.providerSessionId}/parts/${chunk.index + 1}`, {
 *       method: "PUT",
 *       body: data,
 *       headers: { "x-checksum-sha256": sha256Hex },
 *     });
 *     const { etag } = await res.json();
 *     return etag;
 *   },
 *   completeFn: async (session, chunks) => {
 *     await fetch(`/api/upload/${session.providerSessionId}/complete`, {
 *       method: "POST",
 *       body: JSON.stringify({ parts: chunks.map(c => ({ partNumber: c.index + 1, token: c.providerToken })) }),
 *     });
 *   },
 * });
 * ```
 *
 * Security notes:
 *   - The adapter itself does not perform any HTTP requests.
 *   - All network and credential concerns are entirely the responsibility of the
 *     caller-supplied function implementations.
 *   - The adapter never logs or stores credentials.
 */

import type {
  ITransferAdapter,
  ChunkUploadResult,
  RemoteUploadState,
} from "@transferx/core";
import type { TransferSession } from "@transferx/core";
import type { ChunkMeta } from "@transferx/core";

// ── Options ───────────────────────────────────────────────────────────────────

export interface HttpAdapterOptions {
  /**
   * Called once per session to initiate the remote multipart transfer.
   *
   * @param session  - The session that is being initiated.
   * @returns          A provider-assigned session identifier (stored in
   *                   `session.providerSessionId` and passed to all subsequent calls).
   */
  initFn: (session: TransferSession) => Promise<string>;

  /**
   * Called once per chunk to upload its bytes to the remote endpoint.
   *
   * @param session    - The owning session.
   * @param chunk      - Metadata for this chunk (index, offset, size).
   * @param data       - The raw bytes for this chunk.
   * @param sha256Hex  - Pre-computed SHA-256 hex digest of `data`. Pass to the
   *                     server for integrity verification if supported.
   * @returns            An opaque per-chunk token (e.g. ETag, part SHA-1). Stored
   *                     in `chunk.providerToken` and forwarded to `completeFn`.
   */
  uploadFn: (
    session: TransferSession,
    chunk: ChunkMeta,
    data: Uint8Array,
    sha256Hex: string,
  ) => Promise<string>;

  /**
   * Called once after all chunks have been uploaded successfully to finalise
   * the remote transfer.
   *
   * @param session  - The completed session.
   * @param chunks   - All chunks with their `providerToken` values populated.
   */
  completeFn: (session: TransferSession, chunks: ChunkMeta[]) => Promise<void>;

  /**
   * Called when a session is cancelled or fails fatally.
   * Should be best-effort — do not throw if the remote session is already gone.
   *
   * If omitted, abort is a no-op.
   *
   * @param session  - The session to abort.
   */
  abortFn?: (session: TransferSession) => Promise<void>;

  /**
   * Optional: query the remote endpoint for already-uploaded parts.
   *
   * Used during resume reconciliation to skip re-uploading chunks the provider
   * already has. If omitted, the engine trusts the local session state on resume.
   *
   * @param session  - The session to query.
   * @returns          Uploaded parts; `partNumber` is 1-based.
   */
  getRemoteStateFn?: (session: TransferSession) => Promise<RemoteUploadState>;
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export class HttpAdapter implements ITransferAdapter {
  private readonly _opts: HttpAdapterOptions;

  /**
   * `getRemoteState` is only present on the instance when `getRemoteStateFn`
   * is provided in options. The engine checks `if (!adapter.getRemoteState)`
   * before calling it, so the conditional assignment is the correct pattern
   * here — it avoids the engine always going through the throw-and-catch path.
   */
  getRemoteState?: (session: TransferSession) => Promise<RemoteUploadState>;

  constructor(opts: HttpAdapterOptions) {
    this._opts = opts;
    if (opts.getRemoteStateFn) {
      // Capture fn to avoid re-closure over mutable opts reference
      const fn = opts.getRemoteStateFn;
      this.getRemoteState = (session: TransferSession) => fn(session);
    }
  }

  // ── ITransferAdapter ───────────────────────────────────────────────────────

  async initTransfer(session: TransferSession): Promise<string> {
    return this._opts.initFn(session);
  }

  async uploadChunk(
    session: TransferSession,
    chunk: ChunkMeta,
    data: Uint8Array,
    sha256Hex: string,
  ): Promise<ChunkUploadResult> {
    const providerToken = await this._opts.uploadFn(
      session,
      chunk,
      data,
      sha256Hex,
    );
    return { providerToken };
  }

  async completeTransfer(
    session: TransferSession,
    chunks: ChunkMeta[],
  ): Promise<void> {
    return this._opts.completeFn(session, chunks);
  }

  async abortTransfer(session: TransferSession): Promise<void> {
    if (this._opts.abortFn) {
      await this._opts.abortFn(session).catch(() => undefined);
    }
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create a new {@link HttpAdapter} from the given callback options.
 *
 * @example
 * ```ts
 * const adapter = createHttpAdapter({
 *   initFn:     async (session) => myApi.initUpload(session.targetKey),
 *   uploadFn:   async (session, chunk, data) => myApi.uploadPart(session.providerSessionId, chunk.index + 1, data),
 *   completeFn: async (session, chunks) => myApi.completeUpload(session.providerSessionId, chunks),
 *   abortFn:    async (session) => myApi.abortUpload(session.providerSessionId),
 * });
 * ```
 */
export function createHttpAdapter(opts: HttpAdapterOptions): HttpAdapter {
  return new HttpAdapter(opts);
}
