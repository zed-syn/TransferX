/**
 * @module retry/RetryEngine
 *
 * Chunk-level retry logic with exponential backoff + full-jitter.
 *
 * Key design decisions:
 *
 * 1. FULL JITTER (not "decorrelated jitter"):
 *    delay = random(0, min(maxDelay, base * 2^attempt))
 *    This is AWS's recommended strategy and prevents retry storms
 *    when many chunks fail simultaneously.
 *
 * 2. CLASSIFICATION:
 *    The retry engine checks TransferError.isRetryable.
 *    Non-retryable errors immediately move the chunk to 'fatal'.
 *    This avoids wasting retry budget on client-side bugs (4xx).
 *
 * 3. RATE LIMIT AWARENESS:
 *    HTTP 429 responses carry a Retry-After header; the engine
 *    respects that value instead of its own backoff formula.
 *
 * 4. BUDGET-BASED:
 *    After maxAttempts the chunk is marked 'fatal' — no more attempts.
 *    This guarantees finite execution time.
 */

import type { ChunkMeta } from "../types/chunk.js";
import type { RetryPolicy } from "../types/config.js";
import { TransferError, networkError } from "../types/errors.js";

export interface RetryContext {
  chunk: ChunkMeta;
  policy: RetryPolicy;
  /** Called when a retryable failure occurs before the next attempt. */
  onRetryableFailure?: (
    chunk: ChunkMeta,
    error: TransferError,
    attemptNumber: number,
  ) => void;
}

/**
 * Wrap a chunk upload operation with retry + backoff logic.
 *
 * @param operation  - The async operation to wrap.
 *                     May throw TransferError (or any Error).
 * @param ctx        - Retry context (chunk + policy).
 * @returns          - Resolves when the operation succeeds.
 * @throws           - The last TransferError when all attempts are exhausted,
 *                     or immediately if the error is non-retryable.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  ctx: RetryContext,
): Promise<T> {
  const { chunk, policy } = ctx;
  let lastError: TransferError = networkError(
    "Unknown error",
    undefined,
    chunk.index,
  );

  for (let attempt = 0; attempt < policy.maxAttempts; attempt++) {
    // Apply backoff delay for all attempts after the first
    if (attempt > 0) {
      const delayMs = computeBackoff(attempt, policy, lastError);
      await sleep(delayMs);
    }

    try {
      return await operation();
    } catch (err: unknown) {
      const txError = normalise(err, chunk.index);

      if (!txError.isRetryable) {
        // Non-retryable — fail immediately, do not waste the remaining budget.
        throw txError;
      }

      lastError = txError;
      ctx.onRetryableFailure?.(chunk, txError, attempt + 1);

      // No budget left for another attempt
      if (attempt === policy.maxAttempts - 1) {
        throw lastError;
      }
    }
  }

  // Should never reach here, but TypeScript requires a return.
  throw lastError;
}

// ── Backoff calculation ──────────────────────────────────────────────────────

/**
 * Compute the delay before the next retry attempt using full-jitter
 * exponential backoff.
 *
 * Formula:
 *   capMs  = min(maxDelayMs, baseDelayMs * 2^attempt)
 *   delay  = random(0, capMs) + random(0, jitterMs)
 */
export function computeBackoff(
  attempt: number, // 1-based (second attempt = 1, third = 2 …)
  policy: RetryPolicy,
  error?: TransferError,
): number {
  // Honour explicit retry-after from rate limit errors
  if (error?.category === "rateLimit") {
    // The error message encodes the retry-after if present:
    // "Rate limited — retry after {N}ms"
    const match = error.message.match(/retry after (\d+)ms/i);
    if (match) return parseInt(match[1]!, 10);
    // Default rate-limit backoff: 60 s
    return 60_000;
  }

  const cap = Math.min(
    policy.maxDelayMs,
    policy.baseDelayMs * Math.pow(2, attempt),
  );
  const base = Math.random() * cap;
  const jitter = Math.random() * policy.jitterMs;
  return Math.floor(base + jitter);
}

// ── Utilities ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Normalise any thrown value into a TransferError.
 * This isolates the rest of the codebase from raw Error/string throws.
 */
function normalise(err: unknown, chunkIndex?: number): TransferError {
  if (err instanceof TransferError) return err;
  if (err instanceof Error) {
    return new TransferError(err.message, "unknown", err, chunkIndex);
  }
  return new TransferError(String(err), "unknown", undefined, chunkIndex);
}
