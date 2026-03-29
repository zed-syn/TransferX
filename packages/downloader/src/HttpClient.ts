/**
 * @module HttpClient
 *
 * HTTP transport abstraction for DownloadEngine.
 *
 * The core performance problem with the previous architecture:
 *   fetch() per chunk → new TCP + TLS handshake per chunk
 *   → high latency overhead on every chunk boundary
 *   → bandwidth under-utilised during handshake ramp-up
 *
 * Solution: one shared undici.Pool per origin per download task.
 *   Pool keeps HTTP/1.1 keep-alive sockets alive between chunks.
 *   TCP + TLS is paid once (or a small number of times to fill the pool).
 *   All N parallel chunk requests reuse those sockets.
 *
 * Two implementations:
 *
 *   FetchHttpClient   — wraps the WHATWG Fetch API.
 *                       Used when config.fetch is set (test injection) or undici
 *                       is absent. One new connection per request.
 *
 *   PooledHttpClient  — wraps undici.Pool. Persistent keep-alive pool for one
 *                       origin. Created once per download task in start(),
 *                       destroyed via close() after the download completes.
 *
 * Factory:
 *   createHttpClient(url, maxConnections, fetchOverride?)
 *     → FetchHttpClient  if fetchOverride is provided
 *     → PooledHttpClient if undici is installed
 *     → FetchHttpClient  otherwise (graceful degradation)
 */

import { Readable } from "stream";

// ─── Public interfaces ────────────────────────────────────────────────────────

export interface IHttpResponse {
  /** HTTP status code. */
  readonly status: number;
  /** Case-insensitive header lookup. Returns null when absent. */
  header(name: string): string | null;
  /** Web Streams ReadableStream body, or null for bodyless responses. */
  readonly body: ReadableStream<Uint8Array> | null;
  /** Cancel / drain the response body and release the connection. */
  cancel(): Promise<void>;
}

export interface IHttpRequestOptions {
  method?: "GET" | "HEAD";
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface ConnectionStats {
  /** Total number of requests dispatched. */
  requests: number;
  /**
   * Fraction of requests that reused an existing connection (0–1).
   * Always 0 for FetchHttpClient (no persistent connections).
   */
  reuseRate: number;
  /** Whether this client maintains a persistent connection pool. */
  pooled: boolean;
  /** Origin managed by this pool (PooledHttpClient only). */
  origin?: string;
}

export interface IHttpClient {
  request(url: string, opts: IHttpRequestOptions): Promise<IHttpResponse>;
  /**
   * Drain and close all pooled connections.
   * No-op for FetchHttpClient.
   * Must be called after the download task finishes to avoid socket leaks.
   */
  close(): Promise<void>;
  /** Snapshot of connection-reuse statistics for observability. */
  stats(): ConnectionStats;
}

// ─── FetchHttpClient ──────────────────────────────────────────────────────────

/**
 * HTTP client backed by the WHATWG Fetch API.
 *
 * Backward-compatible baseline — used when:
 *   - A custom fetch is injected (typically for test isolation).
 *   - undici is not installed.
 *
 * Creates a new TCP connection per request (no connection reuse).
 */
export class FetchHttpClient implements IHttpClient {
  private readonly _fn: typeof fetch;
  private _requestCount = 0;

  constructor(fetchFn: typeof fetch = globalThis.fetch) {
    this._fn = fetchFn;
  }

  async request(
    url: string,
    opts: IHttpRequestOptions,
  ): Promise<IHttpResponse> {
    this._requestCount++;
    const init: RequestInit = {};
    if (opts.method !== undefined) init.method = opts.method;
    if (opts.headers !== undefined) init.headers = opts.headers;
    if (opts.signal !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (init as any).signal = opts.signal;
    }

    const resp = await this._fn(url, init);
    return {
      status: resp.status,
      header: (name) => resp.headers.get(name),
      body: resp.body,
      cancel: async () => {
        await resp.body?.cancel().catch(() => undefined);
      },
    };
  }

  async close(): Promise<void> {
    // No-op: fetch has no persistent connections to teardown.
  }

  stats(): ConnectionStats {
    return { requests: this._requestCount, reuseRate: 0, pooled: false };
  }
}

// ─── PooledHttpClient ─────────────────────────────────────────────────────────

/**
 * Lazy-loaded undici.Pool constructor.
 * null when undici is not installed (graceful degradation to FetchHttpClient).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let UndiciPool: any | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  UndiciPool = (require("undici") as typeof import("undici")).Pool;
} catch {
  // undici not installed — PooledHttpClient construction will throw clearly.
}

/** Returns true when undici is installed and PooledHttpClient is usable. */
export function isUndiciAvailable(): boolean {
  return UndiciPool !== null;
}

/**
 * HTTP client backed by an undici.Pool.
 *
 * A single pool instance is shared across ALL chunk requests for one download:
 *   - Keep-alive sockets are handed back to the pool after each range response
 *     and immediately available for the next chunk.
 *   - TCP + TLS handshake is paid once to fill the pool to `connections` sockets.
 *   - All N parallel chunk downloads reuse those same sockets.
 *   - pipelining: 1 — safe with all HTTP/1.1 servers (no head-of-line blocking).
 *
 * Lifecycle:
 *   created in InternalTask.start() → used across all chunk fetches → closed
 *   after writer.close() in the finally block of start().
 */
export class PooledHttpClient implements IHttpClient {
  private readonly _origin: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly _pool: any; // undici.Pool — typed as any to avoid hard dep on undici types
  private _requestCount = 0;
  private _reuseCount = 0;

  /**
   * @param origin       Scheme + host + port, e.g. "https://example.com"
   * @param connections  Pool capacity (set equal to concurrency.max so every
   *                     in-flight chunk can have its own socket).
   */
  constructor(origin: string, connections: number) {
    if (!UndiciPool) {
      throw new Error(
        "undici is not installed. Add it as a dependency: npm install undici",
      );
    }
    this._origin = origin;
    this._pool = new UndiciPool(origin, {
      connections,
      pipelining: 1, // safe for all HTTP/1.1 servers
      keepAliveTimeout: 4_000, // keep socket warm between chunks
      keepAliveMaxTimeout: 600_000, // allow multi-minute downloads to reuse
    }) as import("undici").Pool;
  }

  async request(
    url: string,
    opts: IHttpRequestOptions,
  ): Promise<IHttpResponse> {
    // Count reuses: every request after the first benefits from pooling.
    const isReuse = this._requestCount > 0;
    this._requestCount++;
    if (isReuse) this._reuseCount++;

    const parsed = new URL(url);
    const path = parsed.pathname + (parsed.search || "");

    // Build undici request options without assigning undefined properties
    // (satisfies exactOptionalPropertyTypes).
    const reqOpts: Record<string, unknown> = {
      path,
      method: opts.method ?? "GET",
    };
    if (opts.headers !== undefined) reqOpts["headers"] = opts.headers;
    if (opts.signal !== undefined) reqOpts["signal"] = opts.signal;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { statusCode, headers, body } = await this._pool.request(reqOpts);

    const headerMap = _flattenHeaders(
      headers as Record<string, string | string[] | undefined>,
    );

    // undici body is a Node.js Readable; convert to WHATWG ReadableStream.
    // Readable.toWeb() is available from Node.js 17+ (our minimum is 18).
    const webBody: ReadableStream<Uint8Array> | null = body
      ? (Readable.toWeb(body as Readable) as ReadableStream<Uint8Array>)
      : null;

    return {
      status: statusCode as number,
      header: (name) => headerMap.get(name.toLowerCase()) ?? null,
      body: webBody,
      cancel: async () => {
        // Destroy the underlying Node.js Readable to release the socket
        // back to the pool without draining the full body.
        (body as Readable | undefined)?.destroy();
      },
    };
  }

  async close(): Promise<void> {
    await (this._pool as import("undici").Pool).close();
  }

  stats(): ConnectionStats {
    return {
      requests: this._requestCount,
      reuseRate:
        this._requestCount > 1 ? this._reuseCount / this._requestCount : 0,
      pooled: true,
      origin: this._origin,
    };
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create the best available HTTP client for a download task.
 *
 * Priority:
 *   1. fetchOverride is set  → FetchHttpClient(fetchOverride)  [test path]
 *   2. undici is installed   → PooledHttpClient(origin, connections)
 *   3. fallback              → FetchHttpClient(globalThis.fetch)
 *
 * This ensures all existing tests (using config.fetch injection) continue
 * to work identically while production deployments get connection pooling
 * for free as long as undici is installed.
 */
export function createHttpClient(
  url: string,
  maxConnections: number,
  fetchOverride?: typeof fetch,
): IHttpClient {
  if (fetchOverride !== undefined) {
    return new FetchHttpClient(fetchOverride);
  }
  if (isUndiciAvailable()) {
    const origin = new URL(url).origin;
    return new PooledHttpClient(origin, maxConnections);
  }
  return new FetchHttpClient();
}

// ─── Internal utilities ───────────────────────────────────────────────────────

function _flattenHeaders(
  raw: Record<string, string | string[] | undefined>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    map.set(key.toLowerCase(), Array.isArray(value) ? value.join(", ") : value);
  }
  return map;
}
