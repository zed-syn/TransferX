/**
 * @module types/config
 *
 * All user-facing configuration types.
 * Every field is optional at the top level so callers can provide
 * only what they care about; defaults are applied by the engine layer.
 */

// ── Retry policy ─────────────────────────────────────────────────────────────

export interface RetryPolicy {
  /**
   * Maximum number of attempts per chunk (including the first attempt).
   * Default: 5
   */
  maxAttempts: number;
  /**
   * Base delay in ms for exponential backoff.
   * Actual delay = baseDelayMs * 2^(attempt - 1) + jitter.
   * Default: 500
   */
  baseDelayMs: number;
  /**
   * Maximum delay cap in ms regardless of backoff formula.
   * Default: 30_000 (30 s)
   */
  maxDelayMs: number;
  /**
   * Maximum random jitter added to each backoff delay (ms).
   * Helps spread retry storms across multiple concurrent uploads.
   * Default: 500
   */
  jitterMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  jitterMs: 500,
};

// ── Concurrency policy ───────────────────────────────────────────────────────

export interface ConcurrencyPolicy {
  /**
   * Initial number of parallel chunk uploads.
   * When `adaptive` is false this is the fixed concurrency for the entire upload.
   * Default: 4
   */
  initial: number;
  /**
   * Minimum concurrency the adaptive engine will shrink to under high error rates.
   * Default: 1
   */
  min: number;
  /**
   * Maximum concurrency the adaptive engine will grow to when the error rate is low.
   * Default: 16
   */
  max: number;
  /**
   * Whether to enable adaptive concurrency adjustment.
   * When true, the Scheduler maintains a sliding window of the last 20 chunk
   * outcomes and automatically scales concurrency between `min` and `max`:
   *   - errorRate > 30% → scale down (floor: min)
   *   - errorRate < 5% for 10+ consecutive successes → scale up (ceiling: max)
   * Default: true
   */
  adaptive: boolean;
}

export const DEFAULT_CONCURRENCY_POLICY: ConcurrencyPolicy = {
  initial: 4,
  min: 1,
  max: 16,
  adaptive: true,
};

// ── Engine configuration ─────────────────────────────────────────────────────

export interface EngineConfig {
  /**
   * Chunk size in bytes.
   * Constraints:
   *   - Must be >= 5 MiB for B2/S3 multipart (enforced by adapters).
   *   - Must be a positive integer.
   * Default: 10 MiB
   */
  chunkSize: number;
  retry: RetryPolicy;
  concurrency: ConcurrencyPolicy;
  /**
   * Whether to verify chunk integrity with SHA-256 before sending.
   * Slight CPU overhead but prevents silent corruption.
   * Default: true
   */
  checksumVerify: boolean;
  /**
   * Progress event emission interval in ms.
   * Setting too low creates excessive CPU / event overhead.
   * Default: 200
   */
  progressIntervalMs: number;
}

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  chunkSize: 10 * 1024 * 1024, // 10 MiB
  retry: DEFAULT_RETRY_POLICY,
  concurrency: DEFAULT_CONCURRENCY_POLICY,
  checksumVerify: true,
  progressIntervalMs: 200,
};

/** Deep-merge user config with defaults — never mutates defaults. */
export function resolveEngineConfig(
  partial: Partial<EngineConfig>,
): EngineConfig {
  return {
    ...DEFAULT_ENGINE_CONFIG,
    ...partial,
    retry: { ...DEFAULT_ENGINE_CONFIG.retry, ...partial.retry },
    concurrency: {
      ...DEFAULT_ENGINE_CONFIG.concurrency,
      ...partial.concurrency,
    },
  };
}
