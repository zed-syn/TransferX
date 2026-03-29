/**
 * @module types
 *
 * All shared types, interfaces, and enums for @transferx/downloader.
 * Kept in one file so the public API surface is easy to survey at a glance.
 */

// ─── Enums ────────────────────────────────────────────────────────────────────

export type ChunkStatus =
  | "pending" // not yet started
  | "running" // bytes flowing
  | "done" // all bytes written and verified
  | "failed" // latest attempt failed — will retry if budget remains
  | "fatal"; // retries exhausted — entire download is dead

export type DownloadStatus =
  | "idle"
  | "detecting" // capability probe in progress
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export type ErrorCategory =
  | "network" // transient — retry
  | "timeout" // transient — retry
  | "serverError" // 5xx — retry
  | "rangeError" // 416 — non-retryable
  | "notFound" // 404 — non-retryable
  | "auth" // 401/403 — non-retryable
  | "clientError" // 4xx — non-retryable
  | "diskError" // I/O write failure — non-retryable by default
  | "stale" // etag / last-modified mismatch on resume
  | "cancelled" // user-initiated
  | "unknown";

// ─── Chunk ───────────────────────────────────────────────────────────────────

export interface ChunkMeta {
  index: number;
  /** First byte (inclusive) in the remote file. */
  start: number;
  /**
   * Last byte (inclusive) in the remote file.
   *
   * Special value -1 means "stream to EOF" and is used when the server did
   * not provide a Content-Length or does not support range requests. The
   * engine must NOT include a Range header in the request for this chunk.
   * Use RangePlanner.isStreamingChunk(chunk) to test for this case.
   */
  end: number;
  /**
   * end - start + 1 for known-size chunks.
   * 0 for streaming (end === -1) chunks — actual byte count is accumulated
   * in bytesWritten as the download progresses.
   */
  size: number;
  status: ChunkStatus;
  /** How many attempts this chunk has made (including the current). */
  attempts: number;
  /** Bytes confirmed-written for this chunk (0 ≤ bytesWritten ≤ size). */
  bytesWritten: number;
}

// ─── Download session (persisted) ────────────────────────────────────────────

export interface DownloadSession {
  id: string;
  url: string;
  /** Absolute path to the output file. */
  outputPath: string;
  /** Remote file size, or null if unknown (no Content-Length). */
  fileSize: number | null;
  /** ETag from server, for resume validation. */
  etag: string | null;
  /** Last-Modified header, for resume validation. */
  lastModified: string | null;
  /** True when the server supports HTTP range requests. */
  supportsRange: boolean;
  status: DownloadStatus;
  chunks: ChunkMeta[];
  /** Bytes fully confirmed on disk. */
  downloadedBytes: number;
  createdAt: number; // epoch ms
  updatedAt: number; // epoch ms
}

// ─── Config ──────────────────────────────────────────────────────────────────

export interface RetryPolicy {
  /** Total attempts per chunk including the first. Default: 5 */
  maxAttempts: number;
  /** Base delay in ms before exponential backoff. Default: 500 */
  baseDelayMs: number;
  /** Maximum backoff ceiling. Default: 30_000 */
  maxDelayMs: number;
  /** Extra random jitter per retry step. Default: 500 */
  jitterMs: number;
}

export interface ConcurrencyPolicy {
  /** Initial parallel connections. Default: 8 */
  initial: number;
  /** Minimum parallel connections. Default: 1 */
  min: number;
  /** Maximum parallel connections. Default: 32 */
  max: number;
  /** Enable adaptive concurrency tuning. Default: true */
  adaptive: boolean;
}

export interface DownloadConfig {
  /** Target chunk size in bytes. Default: 10 MiB */
  chunkSize: number;
  /** How often (ms) to emit progress events. Default: 200 */
  progressIntervalMs: number;
  /** Per-request timeout in ms. Default: 120_000 */
  timeoutMs: number;
  /** Number of parallel connections. */
  concurrency: ConcurrencyPolicy;
  /** Per-chunk retry behaviour. */
  retry: RetryPolicy;
  /** Custom fetch implementation (for test injection). Default: globalThis.fetch */
  fetch?: typeof fetch;
  /** Custom headers to include in every request. */
  headers?: Record<string, string>;
}

export function resolveDownloadConfig(
  partial: Partial<DownloadConfig>,
): DownloadConfig {
  const concurrency: ConcurrencyPolicy = {
    initial: partial.concurrency?.initial ?? 8,
    min: partial.concurrency?.min ?? 1,
    max: partial.concurrency?.max ?? 32,
    adaptive: partial.concurrency?.adaptive ?? true,
  };
  const retry: RetryPolicy = {
    maxAttempts: partial.retry?.maxAttempts ?? 5,
    baseDelayMs: partial.retry?.baseDelayMs ?? 500,
    maxDelayMs: partial.retry?.maxDelayMs ?? 30_000,
    jitterMs: partial.retry?.jitterMs ?? 500,
  };
  return {
    chunkSize: partial.chunkSize ?? 10 * 1024 * 1024,
    progressIntervalMs: partial.progressIntervalMs ?? 200,
    timeoutMs: partial.timeoutMs ?? 120_000,
    concurrency,
    retry,
    ...(partial.fetch !== undefined ? { fetch: partial.fetch } : {}),
    ...(partial.headers !== undefined ? { headers: partial.headers } : {}),
  };
}

// ─── Progress ────────────────────────────────────────────────────────────────

export interface DownloadProgress {
  taskId: string;
  downloadedBytes: number;
  /**
   * null when the server did not provide a Content-Length.
   * Never divide by this field without a null check — use percent instead.
   */
  totalBytes: number | null;
  /** null when totalBytes is null. In range [0, 100]. */
  percent: number | null;
  /** EMA-smoothed throughput in bytes/second. */
  speedBytesPerSec: number;
  /** null when totalBytes is null or speed is 0. */
  etaSeconds: number | null;
}

// ─── Events ──────────────────────────────────────────────────────────────────

export type DownloadEventMap = {
  start: { taskId: string };
  progress: DownloadProgress;
  chunkStart: { taskId: string; chunk: ChunkMeta };
  chunkComplete: { taskId: string; chunk: ChunkMeta };
  retry: {
    taskId: string;
    chunk: ChunkMeta;
    error: DownloadError;
    attempt: number;
  };
  error: { taskId: string; error: DownloadError };
  pause: { taskId: string };
  resume: { taskId: string };
  completed: { taskId: string; session: DownloadSession };
  cancelled: { taskId: string };
};

export type DownloadEventType = keyof DownloadEventMap;
export type DownloadEventHandler<K extends DownloadEventType> = (
  payload: DownloadEventMap[K],
) => void;

// ─── Errors ──────────────────────────────────────────────────────────────────

export class DownloadError extends Error {
  readonly category: ErrorCategory;
  readonly isRetryable: boolean;
  readonly chunkIndex: number | undefined;
  readonly statusCode: number | undefined;
  override readonly cause: unknown;

  constructor(opts: {
    message: string;
    category: ErrorCategory;
    chunkIndex?: number;
    statusCode?: number;
    cause?: unknown;
  }) {
    super(opts.message);
    this.name = "DownloadError"; // assigned explicitly to override Error.name
    this.category = opts.category;
    this.isRetryable = isRetryableCategory(opts.category);
    this.chunkIndex = opts.chunkIndex;
    this.statusCode = opts.statusCode;
    this.cause = opts.cause;
  }
}

function isRetryableCategory(cat: ErrorCategory): boolean {
  switch (cat) {
    case "network":
    case "timeout":
    case "serverError":
    case "unknown":
      return true;
    default:
      return false;
  }
}

export function networkError(
  msg: string,
  chunkIndex?: number,
  cause?: unknown,
): DownloadError {
  return new DownloadError({
    message: msg,
    category: "network",
    ...(chunkIndex !== undefined ? { chunkIndex } : {}),
    ...(cause !== undefined ? { cause } : {}),
  });
}
export function timeoutError(msg: string, chunkIndex?: number): DownloadError {
  return new DownloadError({
    message: msg,
    category: "timeout",
    ...(chunkIndex !== undefined ? { chunkIndex } : {}),
  });
}
export function diskError(msg: string, cause?: unknown): DownloadError {
  return new DownloadError({
    message: msg,
    category: "diskError",
    ...(cause !== undefined ? { cause } : {}),
  });
}
export function staleError(msg: string): DownloadError {
  return new DownloadError({ message: msg, category: "stale" });
}
export function httpError(
  status: number,
  msg: string,
  chunkIndex?: number,
): DownloadError {
  let cat: ErrorCategory;
  if (status === 416) cat = "rangeError";
  else if (status === 404) cat = "notFound";
  else if (status === 401 || status === 403) cat = "auth";
  else if (status >= 500) cat = "serverError";
  else cat = "clientError";
  return new DownloadError({
    message: msg,
    category: cat,
    statusCode: status,
    ...(chunkIndex !== undefined ? { chunkIndex } : {}),
  });
}

// ─── Capability result ───────────────────────────────────────────────────────

export interface ServerCapability {
  supportsRange: boolean;
  fileSize: number | null;
  etag: string | null;
  lastModified: string | null;
  /** True when the server confirmed 206 for a range probe. */
  rangeProbeOk: boolean;
}
