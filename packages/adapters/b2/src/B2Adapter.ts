/**
 * @module B2Adapter
 *
 * Backblaze B2 Native API adapter for TransferX.
 *
 * B2 multi-part upload lifecycle:
 *
 *   1. b2_authorize_account    → accountId, authorizationToken, apiUrl
 *   2. b2_start_large_file     → fileId (our "providerSessionId")
 *   3. b2_get_upload_part_url  → uploadUrl + uploadAuthToken (per-chunk)
 *   4. POST chunk data to uploadUrl with uploadAuthToken (per-chunk)
 *      Response contains "contentSha1" which becomes providerToken
 *   5. b2_finish_large_file    → combines all parts
 *   (abort path: b2_cancel_large_file)
 *
 * Threading / connection re-use:
 *   B2 upload-part URLs are single-use per concurrent slot.  The adapter
 *   fetches a fresh upload-part URL for EACH chunk to avoid "upload URL is
 *   already in use" errors.  This adds one extra HTTP round-trip per chunk
 *   but is the safest default; callers can override by pooling adapters at
 *   the engine level in a future phase.
 *
 * Authentication:
 *   The adapter re-authorises automatically when it receives a 401.
 *   The engine will call uploadChunk again (via RetryEngine) after the token
 *   is refreshed.
 *
 * Security notes:
 *   - Credentials are received in the constructor, never logged.
 *   - All requests go to HTTPS endpoints provided by B2 authorisation.
 *   - SHA-1 is sent to B2 as required by their API (not our choice of hash).
 *     SHA-256 is computed separately by the engine for integrity checking.
 */

import { createHash } from "node:crypto";
import {
  TransferError,
  networkError,
  serverError,
  clientError,
  authError,
} from "@transferx/core";
import type {
  ITransferAdapter,
  ChunkUploadResult,
  RemoteUploadState,
  LogLevel,
} from "@transferx/core";
import type { TransferSession } from "@transferx/core";
import type { ChunkMeta } from "@transferx/core";

// ── B2 API types (minimal surface needed) ────────────────────────────────────

interface B2AuthResponse {
  accountId: string;
  authorizationToken: string;
  apiUrl: string;
  downloadUrl: string;
}

interface B2StartLargeFileResponse {
  fileId: string;
}

interface B2GetUploadPartUrlResponse {
  uploadUrl: string;
  authorizationToken: string;
}

interface B2UploadPartResponse {
  contentSha1: string;
}

interface B2ListPartsResponse {
  parts: Array<{
    partNumber: number;
    contentSha1: string;
  }>;
  nextPartNumberMarker?: number;
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export interface B2AdapterOptions {
  /** B2 applicationKeyId (a.k.a. keyId). */
  applicationKeyId: string;
  /** B2 applicationKey secret. */
  applicationKey: string;
  /** Target bucket name. */
  bucketId: string;
  /**
   * Optional custom fetch implementation.
   * Defaults to the global `fetch` (Node 18+).
   * Inject a mock in tests to avoid network calls.
   */
  fetch?: typeof fetch;
  /**
   * HTTP request timeout in milliseconds applied to every outbound request.
   * A stalled connection that exceeds this threshold will be aborted and the
   * operation will throw a retryable `network` error.
   * Default: 120_000 (2 minutes)
   */
  timeoutMs?: number;
  /**
   * Optional structured-log callback. Wire this to your engine event bus for
   * end-to-end observability. The `createB2Engine()` helper does this automatically.
   *
   * @example
   * const adapter = new B2Adapter({ ..., onLog: (level, msg, ctx) => bus.emit({ type: 'log', level, message: msg, context: ctx }) });
   */
  onLog?: (
    level: LogLevel,
    message: string,
    context?: Record<string, unknown>,
  ) => void;
}

export class B2Adapter implements ITransferAdapter {
  private readonly _opts: B2AdapterOptions;
  private readonly _fetch: typeof fetch;

  private _auth: B2AuthResponse | null = null;

  constructor(opts: B2AdapterOptions) {
    this._opts = opts;
    this._fetch = opts.fetch ?? globalThis.fetch;
  }

  // ── ITransferAdapter ───────────────────────────────────────────────────────

  async initTransfer(session: TransferSession): Promise<string> {
    const auth = await this._ensureAuth();
    const resp = await this._post<B2StartLargeFileResponse>(
      `${auth.apiUrl}/b2api/v3/b2_start_large_file`,
      auth.authorizationToken,
      {
        bucketId: this._opts.bucketId,
        fileName: session.targetKey,
        contentType: session.file.mimeType || "application/octet-stream",
      },
    );
    return resp.fileId;
  }

  async uploadChunk(
    session: TransferSession,
    chunk: ChunkMeta,
    data: Uint8Array,
    _sha256Hex: string,
  ): Promise<ChunkUploadResult> {
    if (!session.providerSessionId) {
      throw new TransferError(
        "providerSessionId is missing — initTransfer must be called first",
        "fatal",
      );
    }

    // B2 requires SHA-1 of the part data (their design, not ours)
    const sha1 = createHash("sha1").update(data).digest("hex");

    let auth = await this._ensureAuth();
    try {
      return await this._doUploadPart(
        auth,
        session.providerSessionId,
        chunk,
        data,
        sha1,
      );
    } catch (err) {
      // If the upload part URL or the actual upload returned 401, the auth
      // token has expired mid-upload. _assertResponse already cleared
      // this._auth. Re-authorise once and retry transparently before letting
      // the error propagate to the retry engine (which would treat "auth" as
      // non-retryable and permanently fail the chunk).
      if (err instanceof TransferError && err.category === "auth") {
        this._opts.onLog?.(
          "warn",
          "[B2] Auth token expired during upload — refreshing token and retrying chunk",
          {
            sessionId: session.id,
            chunkIndex: chunk.index,
          },
        );
        auth = await this._authorize();
        // If this second attempt throws, we let it propagate naturally.
        return await this._doUploadPart(
          auth,
          session.providerSessionId,
          chunk,
          data,
          sha1,
        );
      }
      throw err;
    }
  }

  async completeTransfer(
    session: TransferSession,
    chunks: ChunkMeta[],
  ): Promise<void> {
    const auth = await this._ensureAuth();
    if (!session.providerSessionId) {
      throw new TransferError(
        "providerSessionId missing in completeTransfer",
        "fatal",
      );
    }

    // B2 expects the SHA-1 list in part order
    const partSha1Array = chunks
      .sort((a, b) => a.index - b.index)
      .map((c) => c.providerToken ?? "");

    await this._post(
      `${auth.apiUrl}/b2api/v3/b2_finish_large_file`,
      auth.authorizationToken,
      {
        fileId: session.providerSessionId,
        partSha1Array,
      },
    );
  }

  async abortTransfer(session: TransferSession): Promise<void> {
    if (!session.providerSessionId) return; // nothing to abort
    try {
      const auth = await this._ensureAuth();
      await this._post(
        `${auth.apiUrl}/b2api/v3/b2_cancel_large_file`,
        auth.authorizationToken,
        { fileId: session.providerSessionId },
      );
    } catch {
      // Best-effort — swallow errors so cancel never blocks the engine
    }
  }

  async getRemoteState(session: TransferSession): Promise<RemoteUploadState> {
    if (!session.providerSessionId) {
      return { uploadedParts: [] };
    }

    const auth = await this._ensureAuth();
    const uploadedParts: RemoteUploadState["uploadedParts"] = [];

    // B2 paginates parts — iterate until no nextPartNumberMarker
    let startPartNumber: number | undefined;
    do {
      const body: Record<string, unknown> = {
        fileId: session.providerSessionId,
        maxPartCount: 1000,
      };
      if (startPartNumber !== undefined) {
        body["startPartNumber"] = startPartNumber;
      }

      const resp = await this._post<B2ListPartsResponse>(
        `${auth.apiUrl}/b2api/v3/b2_list_parts`,
        auth.authorizationToken,
        body,
      );

      for (const p of resp.parts) {
        uploadedParts.push({
          partNumber: p.partNumber,
          providerToken: p.contentSha1,
        });
      }

      startPartNumber = resp.nextPartNumberMarker;
    } while (startPartNumber !== undefined);

    return { uploadedParts };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async _doUploadPart(
    auth: B2AuthResponse,
    fileId: string,
    chunk: ChunkMeta,
    data: Uint8Array,
    sha1: string,
  ): Promise<ChunkUploadResult> {
    const partUrl = await this._getUploadPartUrl(auth, fileId);
    const response = await this._fetchWithTimeout(partUrl.uploadUrl, {
      method: "POST",
      headers: {
        Authorization: partUrl.authorizationToken,
        "Content-Length": String(data.byteLength),
        "X-Bz-Part-Number": String(chunk.index + 1), // B2 parts are 1-indexed
        "X-Bz-Content-Sha1": sha1,
      },
      body: data,
    });
    await this._assertResponse(response, chunk.index);
    const json = (await response.json()) as B2UploadPartResponse;
    return { providerToken: json.contentSha1 };
  }

  private async _ensureAuth(): Promise<B2AuthResponse> {
    if (this._auth) return this._auth;
    return this._authorize();
  }

  private async _authorize(): Promise<B2AuthResponse> {
    const credentials = Buffer.from(
      `${this._opts.applicationKeyId}:${this._opts.applicationKey}`,
    ).toString("base64");

    const response = await this._fetchWithTimeout(
      "https://api.backblazeb2.com/b2api/v3/b2_authorize_account",
      {
        headers: { Authorization: `Basic ${credentials}` },
      },
    );

    if (response.status === 401) {
      throw authError(
        "B2 authorisation failed — check applicationKeyId and applicationKey",
      );
    }
    if (!response.ok) {
      throw serverError(response.status, await response.text());
    }

    this._auth = (await response.json()) as B2AuthResponse;
    return this._auth;
  }

  private async _getUploadPartUrl(
    auth: B2AuthResponse,
    fileId: string,
  ): Promise<B2GetUploadPartUrlResponse> {
    return this._post<B2GetUploadPartUrlResponse>(
      `${auth.apiUrl}/b2api/v3/b2_get_upload_part_url`,
      auth.authorizationToken,
      { fileId },
    );
  }

  private async _post<T>(
    url: string,
    token: string,
    body: unknown,
  ): Promise<T> {
    const response = await this._fetchWithTimeout(url, {
      method: "POST",
      headers: {
        Authorization: token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    await this._assertResponse(response);
    return response.json() as Promise<T>;
  }

  /**
   * Fetch wrapper that enforces a per-request timeout via AbortController.
   * On timeout, throws a retryable `network` error.
   * On network failure, normalises the raw error into `networkError`.
   */
  private async _fetchWithTimeout(
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    const timeoutMs = this._opts.timeoutMs ?? 120_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this._fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw networkError(`B2 request timed out after ${timeoutMs}ms`, err);
      }
      throw networkError(`B2 request failed: ${String(err)}`, err);
    } finally {
      clearTimeout(timer);
    }
  }

  private async _assertResponse(
    response: Response,
    chunkIndex?: number,
  ): Promise<void> {
    if (response.ok) return;

    const body = await response.text().catch(() => "");
    const status = response.status;

    if (status === 401) {
      // Token expired — invalidate so next call triggers re-auth
      this._auth = null;
      throw authError(`B2 401 Unauthorized: ${body}`);
    }
    if (status === 429) {
      // Extract Retry-After header if present
      const retryAfter = response.headers.get("Retry-After");
      const retryAfterMs = retryAfter
        ? parseInt(retryAfter, 10) * 1000
        : undefined;
      throw new TransferError(
        retryAfterMs != null
          ? `Rate limited — retry after ${retryAfterMs}ms`
          : "Rate limited",
        "rateLimit",
        undefined,
        chunkIndex,
      );
    }
    if (status >= 500) {
      throw serverError(status, body);
    }
    throw clientError(status, body);
  }
}
