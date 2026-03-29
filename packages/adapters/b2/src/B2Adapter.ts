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
import type { ITransferAdapter, ChunkUploadResult } from "@transferx/core";
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
    const auth = await this._ensureAuth();
    if (!session.providerSessionId) {
      throw new TransferError(
        "providerSessionId is missing — initTransfer must be called first",
        "fatal",
      );
    }

    // B2 requires SHA-1 of the part data (their design, not ours)
    const sha1 = createHash("sha1").update(data).digest("hex");

    const partUrl = await this._getUploadPartUrl(
      auth,
      session.providerSessionId,
    );

    const response = await this._fetch(partUrl.uploadUrl, {
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

  // ── Private helpers ────────────────────────────────────────────────────────

  private async _ensureAuth(): Promise<B2AuthResponse> {
    if (this._auth) return this._auth;
    return this._authorize();
  }

  private async _authorize(): Promise<B2AuthResponse> {
    const credentials = Buffer.from(
      `${this._opts.applicationKeyId}:${this._opts.applicationKey}`,
    ).toString("base64");

    const response = await this._fetch(
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
    let response: Response;
    try {
      response = await this._fetch(url, {
        method: "POST",
        headers: {
          Authorization: token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (err: unknown) {
      throw networkError(`B2 request failed: ${String(err)}`, err);
    }

    await this._assertResponse(response);
    return response.json() as Promise<T>;
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
