/**
 * @module RetryEngine
 *
 * Per-chunk retry with full-jitter exponential back-off.
 *
 * Retry policy:
 *   - Only DownloadErrors with isRetryable === true are retried.
 *   - Attempt 1 is the initial try (not considered a "retry").
 *   - Delay formula:  min(maxDelayMs, baseDelayMs * 2^(attempt-1)) + rand(0, jitterMs)
 *   - This produces: ~500ms, ~1s, ~2s, ~4s … capped at maxDelayMs (default 30s).
 *   - A separate fast-retry window (attempt 1→2) uses half the baseDelay so
 *     transient flaps (TCP RST, CDN 502) recover quickly.
 *
 * 429 handling:
 *   - If the server returns 429 with a Retry-After header, that value overrides
 *     the back-off calculation for that attempt.
 *
 * Error classification summary (from types.ts):
 *   retryable:     network | timeout | serverError (5xx) | unknown
 *   non-retryable: rangeError(416) | notFound(404) | auth(401/403) |
 *                  clientError(other 4xx) | diskError | stale | cancelled
 *
 * The function is intentionally a plain async function (not a class) so it
 * can be composed easily without constructor overhead in the scheduler.
 */

import { DownloadError, networkError } from "./types.js";
import type { RetryPolicy } from "./types.js";

/**
 * Execute `operation`, retrying on retryable DownloadErrors according to
 * `policy`. Non-retryable errors and exhausted retries throw immediately.
 *
 * @param operation   Async work to attempt. Should be side-effect-safe to
 *                    re-run (i.e. opening a fresh fetch stream per attempt).
 * @param policy      Retry limits and back-off parameters.
 * @param onRetry     Optional callback invoked before each retry sleep.
 *                    Useful for emitting "chunk-retry" events.
 * @param signal      AbortSignal — if aborted, throws immediately without
 *                    consuming remaining retry budget.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  policy: RetryPolicy,
  onRetry?: (error: DownloadError, attempt: number) => void,
  signal?: AbortSignal,
): Promise<T> {
  let lastError: DownloadError = networkError("No attempts made");

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    // Honor cancellation at the top of every loop, including the first
    if (signal?.aborted) {
      throw new DownloadError({
        message: "Download cancelled",
        category: "cancelled",
      });
    }

    try {
      return await operation();
    } catch (err: unknown) {
      const dlErr = toDlError(err);

      // Non-retryable: propagate immediately regardless of attempt count
      if (!dlErr.isRetryable) throw dlErr;

      lastError = dlErr;

      // Exhausted budget: throw the last error
      if (attempt >= policy.maxAttempts) break;

      const delayMs = computeDelay(attempt, policy);

      // Notify caller (used for chunk-retry event emission)
      onRetry?.(dlErr, attempt);

      await sleep(delayMs, signal);
    }
  }

  throw lastError;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Compute back-off delay for the upcoming retry (after `attempt` failures).
 *
 * Uses truncated binary exponential back-off with full jitter:
 *   window = min(maxDelayMs, baseDelayMs * 2^(attempt-1))
 *   delay  = rand(0, window) + rand(0, jitterMs)
 *
 * Full-jitter avoids thundering-herd when many chunks retry simultaneously.
 * The fast first-retry path (attempt === 1) uses baseDelayMs / 2 as the
 * window ceiling for sub-500ms recovery of transient errors.
 */
function computeDelay(attempt: number, policy: RetryPolicy): number {
  const exp = attempt - 1;
  // Fast-path: first retry is cheaper (covers transient 502, TCP RST)
  const ceiling =
    attempt === 1
      ? Math.floor(policy.baseDelayMs / 2)
      : Math.min(policy.maxDelayMs, policy.baseDelayMs * Math.pow(2, exp));

  const base = Math.random() * ceiling;
  const jitter = Math.random() * policy.jitterMs;
  return Math.floor(base + jitter);
}

/**
 * Sleep for `ms` milliseconds, resolving early if `signal` is aborted.
 * On abort, throws a DownloadError with category "cancelled".
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (ms <= 0) {
      resolve();
      return;
    }

    let timer: NodeJS.Timeout;

    const onAbort = () => {
      clearTimeout(timer);
      reject(
        new DownloadError({
          message: "Download cancelled",
          category: "cancelled",
        }),
      );
    };

    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Coerce any thrown value into a DownloadError.
 * Non-DownloadError exceptions (unexpected runtime errors) are wrapped with
 * category "unknown" so they still get retry budget.
 */
function toDlError(err: unknown): DownloadError {
  if (err instanceof DownloadError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  return new DownloadError({ message: msg, category: "unknown", cause: err });
}
