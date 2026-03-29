/**
 * @module types/errors
 *
 * Error taxonomy for TransferX.
 *
 * Design principle: every error knows whether it is retryable at the chunk
 * level. This lets the retry engine make the right decision without hard-coding
 * HTTP status codes or adapter-specific strings throughout the codebase.
 */

export type ErrorCategory =
  | "network" // transient connectivity issue → retryable
  | "rateLimit" // HTTP 429 / provider throttle → retryable with backoff
  | "serverError" // HTTP 5xx → retryable
  | "clientError" // HTTP 4xx (except 429) → NOT retryable (our bug)
  | "auth" // 401/403 → NOT retryable without token refresh
  | "checksum" // local data integrity failure → retryable (re-read chunk)
  | "cancelled" // user-initiated → NOT retryable
  | "fatal" // unrecoverable state → NOT retryable
  | "unknown"; // catch-all → retryable (be conservative)

export const RETRYABLE_CATEGORIES = new Set<ErrorCategory>([
  "network",
  "rateLimit",
  "serverError",
  "checksum",
  "unknown",
]);

export class TransferError extends Error {
  override readonly name = "TransferError";

  constructor(
    message: string,
    public readonly category: ErrorCategory,
    public override readonly cause?: unknown,
    public readonly chunkIndex?: number,
    public readonly sessionId?: string,
  ) {
    super(message);
    // Restore prototype chain (TypeScript extends Error quirk)
    Object.setPrototypeOf(this, new.target.prototype);
  }

  get isRetryable(): boolean {
    return RETRYABLE_CATEGORIES.has(this.category);
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      category: this.category,
      isRetryable: this.isRetryable,
      chunkIndex: this.chunkIndex,
      sessionId: this.sessionId,
    };
  }
}

// ── Convenience constructors ─────────────────────────────────────────────────

export function networkError(
  msg: string,
  cause?: unknown,
  chunkIndex?: number,
): TransferError {
  return new TransferError(msg, "network", cause, chunkIndex);
}

export function rateLimitError(retryAfterMs?: number): TransferError {
  return new TransferError(
    `Rate limited${retryAfterMs != null ? ` — retry after ${retryAfterMs}ms` : ""}`,
    "rateLimit",
    undefined,
  );
}

export function serverError(status: number, body?: string): TransferError {
  return new TransferError(
    `Server error HTTP ${status}: ${body ?? ""}`,
    "serverError",
  );
}

export function clientError(status: number, body?: string): TransferError {
  return new TransferError(
    `Client error HTTP ${status}: ${body ?? ""}`,
    "clientError",
  );
}

export function authError(msg: string): TransferError {
  return new TransferError(msg, "auth");
}

export function checksumError(
  chunkIndex: number,
  expected: string,
  got: string,
): TransferError {
  return new TransferError(
    `Checksum mismatch on chunk ${chunkIndex}: expected ${expected}, got ${got}`,
    "checksum",
    undefined,
    chunkIndex,
  );
}

export function cancelledError(sessionId: string): TransferError {
  return new TransferError(
    `Transfer cancelled`,
    "cancelled",
    undefined,
    undefined,
    sessionId,
  );
}
