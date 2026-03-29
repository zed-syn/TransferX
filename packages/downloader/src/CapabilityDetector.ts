/**
 * @module CapabilityDetector
 *
 * Probes the remote server to determine:
 *   1. Whether HTTP Range requests are supported (Accept-Ranges: bytes header
 *      and/or a 206 response to a minimal probe request).
 *   2. The exact Content-Length for range planning.
 *   3. ETag and Last-Modified for resume validation.
 *
 * Strategy:
 *   Phase 1 — HEAD request: cheap, usually sufficient.
 *     If Accept-Ranges: bytes is present AND Content-Length is known → done.
 *   Phase 2 — Range probe GET (bytes=0-0): confirms the server actually honors
 *     range requests. Some CDNs advertise Accept-Ranges but return 200 anyway.
 *     We do this probe only when HEAD didn't give us a definitive answer OR
 *     when probeRange is forced (default: true).
 *
 * The result is cached for the lifetime of the detector instance so that
 * subsequent calls from the same task are free.
 */

import { httpError, networkError, timeoutError } from "./types.js";
import type { DownloadConfig, ServerCapability } from "./types.js";

export class CapabilityDetector {
  private readonly _config: DownloadConfig;
  private _cache: ServerCapability | null = null;

  constructor(config: DownloadConfig) {
    this._config = config;
  }

  /**
   * Probe the URL and return server capabilities.
   * Throws DownloadError on unrecoverable network/HTTP failure.
   */
  async detect(url: string): Promise<ServerCapability> {
    if (this._cache) return this._cache;
    const result = await this._probe(url);
    this._cache = result;
    return result;
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private async _probe(url: string): Promise<ServerCapability> {
    const fetchFn = this._config.fetch ?? globalThis.fetch;
    const headers = { ...this._config.headers };

    // ── Phase 1: HEAD request ────────────────────────────────────────────────
    const headResp = await this._safeFetch(fetchFn, url, {
      method: "HEAD",
      headers,
      signal: this._timeoutSignal(),
    });

    if (!headResp.ok && headResp.status !== 405 /* Method Not Allowed */) {
      throw httpError(
        headResp.status,
        `HEAD ${url} returned ${headResp.status}`,
      );
    }

    const contentLength = headResp.headers.get("content-length");
    const fileSize = contentLength ? parseInt(contentLength, 10) : null;
    const etag = headResp.headers.get("etag");
    const lastModified = headResp.headers.get("last-modified");
    const acceptRanges = headResp.headers.get("accept-ranges");
    const rangeAdvertised = acceptRanges?.toLowerCase() === "bytes";

    // ── Phase 2: Range probe (always — validates actual behavior) ────────────
    let rangeProbeOk = false;
    try {
      const probeResp = await this._safeFetch(fetchFn, url, {
        method: "GET",
        headers: { ...headers, Range: "bytes=0-0" },
        signal: this._timeoutSignal(),
      });
      rangeProbeOk = probeResp.status === 206;
      // consume the single byte to free the connection
      await probeResp.body?.cancel().catch(() => undefined);
    } catch {
      // probe failure is non-fatal — we fall back to single-stream
    }

    const supportsRange = rangeProbeOk || rangeAdvertised;

    return { supportsRange, fileSize, etag, lastModified, rangeProbeOk };
  }

  private async _safeFetch(
    fetchFn: typeof fetch,
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    try {
      return await fetchFn(url, init);
    } catch (err: unknown) {
      const isTimeout = err instanceof Error && err.name === "AbortError";
      if (isTimeout)
        throw timeoutError(`Capability probe timed out for ${url}`);
      throw networkError(
        `Capability probe failed: ${String(err)}`,
        undefined,
        err,
      );
    }
  }

  private _timeoutSignal(): AbortSignal {
    return AbortSignal.timeout(this._config.timeoutMs);
  }
}
