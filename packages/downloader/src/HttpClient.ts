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
   * Fraction of requests that found a warm idle socket at dispatch time (0–1).
   * Measured by checking pool.stats.free > 0 before each undici dispatch.
   * Always 0 for FetchHttpClient (no persistent connections).
   */
  reuseRate: number;
  /** Whether this client maintains a persistent connection pool. */
  pooled: boolean;
  /** Origin managed by this pool (PooledHttpClient only). */
  origin?: string;
  /** Current active-concurrency limit after adaptive tuning. Pool-only. */
  activeConnections?: number;
  /** Original max-connections cap (≤ 8). Pool-only. */
  maxConnections?: number;
  /** Whether HTTP/2 (ALPN h2) negotiation is enabled for this pool. Pool-only. */
  http2?: boolean;
  /** Rolling error rate over the last measurement window (0–1). Pool-only. */
  errorRate?: number;
}

/** Configuration options for PooledHttpClient. */
export interface PooledHttpClientOptions {
  /**
   * HTTP/1.1 pipelining depth per socket.
   * 2–4 saturates bandwidth without head-of-line stalls on most CDNs.
   * Ignored when HTTP/2 is negotiated (streams are natively multiplexed).
   * Default: 2.
   */
  pipelining?: number;
  /**
   * Enable HTTP/2 via ALPN negotiation.
   * When true, undici upgrades to h2 if the server advertises it.
   * Default: true for https: origins, false for http:.
   */
  allowH2?: boolean;
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
 * Performance strategy:
 *   - connections = min(requested, 8): caps at typical CDN per-IP limit.
 *   - pipelining = 2 (configurable): two in-flight requests per socket without
 *     head-of-line blocking — doubles effective throughput vs pipelining=1.
 *   - allowH2 = true for https: — ALPN upgrades to HTTP/2 multiplexing;
 *     single connection then handles all concurrent chunk streams.
 *   - Adaptive _Sem: a runtime semaphore mirrors pool capacity and shrinks by
 *     25 % (floor 2) on error-rate > 30 %, recovering +1 per success-run.
 *     No pool rebuild needed — just rate-limits new dispatches.
 *   - Real reuseRate: pool.stats.free is sampled before each dispatch;
 *     free > 0 means an idle socket was available (genuine warm reuse).
 *
 * Lifecycle:
 *   created in InternalTask.start() → used across all chunk fetches → closed
 *   after writer.close() in the finally block of start().
 */
export class PooledHttpClient implements IHttpClient {
  private readonly _origin: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly _pool: any; // undici.Pool — typed as any to avoid hard dep on undici types
  private readonly _sem: _Sem;
  private readonly _maxConn: number;
  private readonly _http2: boolean;

  private _requestCount = 0;
  private _socketReuseCount = 0; // requests that found a warm idle socket

  // Circular error-rate window — 16 slots, each 0 = ok / 1 = error.
  private static readonly _WIN = 16;
  private readonly _errWin = new Uint8Array(PooledHttpClient._WIN); // all zeros
  private _errIdx = 0;
  private _errSum = 0; // running sum of 1-bits in the window

  /**
   * @param origin       Scheme + host + port, e.g. "https://example.com"
   * @param connections  Desired pool capacity. Capped at 8 internally to match
   *                     typical CDN per-IP connection limits.
   * @param opts         Optional tuning: pipelining depth, HTTP/2 toggle.
   */
  constructor(origin: string, connections: number, opts?: PooledHttpClientOptions) {
    if (!UndiciPool) {
      throw new Error(
        "undici is not installed. Add it as a dependency: npm install undici",
      );
    }
    const n = Math.min(Math.max(1, connections), 8); // 1 ≤ n ≤ 8
    this._maxConn = n;
    this._origin = origin;
    this._http2 = opts?.allowH2 ?? origin.startsWith("https:");
    this._pool = new UndiciPool(origin, {
      connections: n,
      pipelining: opts?.pipelining ?? 2, // sweet-spot: fills pipe without HOL stalls
      allowH2: this._http2,              // ALPN h2 negotiation for HTTPS origins
      keepAliveTimeout: 4_000,           // keep socket warm between chunks
      keepAliveMaxTimeout: 600_000,      // allow multi-minute downloads to reuse
    }) as import("undici").Pool;
    this._sem = new _Sem(n); // mirrors pool capacity; shrinks/grows via adaptive tuning
  }

  async request(
    url: string,
    opts: IHttpRequestOptions,
  ): Promise<IHttpResponse> {
    // Adaptive semaphore: may be reduced below _maxConn on error spikes.
    await this._sem.acquire();

    // Sample free (idle) sockets BEFORE dispatching the request.
    // If pool.stats.free > 0 the request grabs a warm socket — genuine reuse.
    // After dispatch the pool decrements free internally, so we must read it first.
    const freeAtDispatch = (this._pool.stats as { free: number }).free;
    this._requestCount++;
    if (freeAtDispatch > 0) this._socketReuseCount++;

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

    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const { statusCode, headers, body } = await this._pool.request(reqOpts);

      // HTTP 5xx counts as an error for adaptive-tuning purposes.
      this._recordOutcome((statusCode as number) >= 500);

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
    } catch (err) {
      // Network-level failure (ECONNRESET, DNS, timeout) — count as error.
      this._recordOutcome(true);
      throw err;
    } finally {
      // Release the semaphore as soon as headers arrive (or request fails).
      // The socket stays busy reading the body — that is managed by undici.
      this._sem.release();
    }
  }

  async close(): Promise<void> {
    await (this._pool as import("undici").Pool).close();
  }

  stats(): ConnectionStats {
    const n = Math.min(this._requestCount, PooledHttpClient._WIN);
    return {
      requests: this._requestCount,
      reuseRate:
        this._requestCount > 0 ? this._socketReuseCount / this._requestCount : 0,
      pooled: true,
      origin: this._origin,
      activeConnections: this._sem.limit,
      maxConnections: this._maxConn,
      http2: this._http2,
      errorRate: n > 0 ? this._errSum / n : 0,
    };
  }

  /** Update rolling error window and adjust semaphore limit accordingly. */
  private _recordOutcome(isError: boolean): void {
    const old = this._errWin[this._errIdx];
    const neu = isError ? 1 : 0;
    this._errSum = this._errSum - (old ?? 0) + neu;
    this._errWin[this._errIdx] = neu;
    this._errIdx = (this._errIdx + 1) % PooledHttpClient._WIN;

    // Use actual sample count until the window fills to avoid cold-start bias.
    const sampleN = Math.min(this._requestCount, PooledHttpClient._WIN);
    const rate = sampleN > 0 ? this._errSum / sampleN : 0;

    if (isError && rate > 0.3) {
      // Error spike — back off concurrency by 25 %, floor at 2.
      this._sem.limit = Math.max(2, Math.floor(this._sem.limit * 0.75));
    } else if (!isError && rate < 0.1 && this._sem.limit < this._maxConn) {
      // Sustained success — recover one step toward the original cap.
      this._sem.limit = Math.min(this._maxConn, this._sem.limit + 1);
    }
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

// ─── Internal: adaptive concurrency semaphore ───────────────────────────────

/**
 * Lightweight permit-based semaphore with a mutable limit.
 *
 * PooledHttpClient uses this to throttle concurrent undici dispatches without
 * rebuilding the pool. Raising or lowering `limit` takes effect immediately:
 * raising unblocks queued waiters; lowering starves new acquires until running
 * count drops below the new limit.
 */
class _Sem {
  private _n: number;
  private _running = 0;
  private readonly _q: Array<() => void> = [];

  constructor(limit: number) {
    this._n = Math.max(1, limit);
  }

  get limit(): number {
    return this._n;
  }

  set limit(v: number) {
    this._n = Math.max(1, v);
    this._flush(); // unblock queued waiters if limit was raised
  }

  acquire(): Promise<void> {
    if (this._running < this._n) {
      this._running++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this._q.push(resolve));
  }

  release(): void {
    this._running--;
    this._flush();
  }

  private _flush(): void {
    while (this._running < this._n && this._q.length > 0) {
      this._running++;
      const resolve = this._q.shift();
      resolve?.();
    }
  }
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
