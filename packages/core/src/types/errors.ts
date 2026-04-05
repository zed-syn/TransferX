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
  | "invalidState" // operation not allowed in current state → NOT retryable
  | "sessionNotFound" // session not in store → NOT retryable
  | "fileChanged" // source file changed since session created → NOT retryable
  | "zeroByte" // empty file can't use multipart upload → NOT retryable
  | "concurrentUpload" // engine already running this session → NOT retryable
  | "duplicateUpload" // another non-terminal session targets the same remoteKey → NOT retryable
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

export function invalidStateError(
  sessionId: string,
  current: string,
  operation: string,
): TransferError {
  return new TransferError(
    `Cannot ${operation}: session '${sessionId}' is in state '${current}'`,
    "invalidState",
    undefined,
    undefined,
    sessionId,
  );
}

export function sessionNotFoundError(sessionId: string): TransferError {
  return new TransferError(
    `Session '${sessionId}' not found in store`,
    "sessionNotFound",
    undefined,
    undefined,
    sessionId,
  );
}

export function fileChangedError(sessionId: string): TransferError {
  return new TransferError(
    `Source file has changed since session '${sessionId}' was created — cannot resume`,
    "fileChanged",
    undefined,
    undefined,
    sessionId,
  );
}

export function zeroByteError(): TransferError {
  return new TransferError(
    "Cannot start a multipart upload for a zero-byte file",
    "zeroByte",
  );
}

export function concurrentUploadError(sessionId: string): TransferError {
  return new TransferError(
    `Session '${sessionId}' is already being uploaded by this engine`,
    "concurrentUpload",
    undefined,
    undefined,
    sessionId,
  );
}

export function duplicateUploadError(
  targetKey: string,
  existingSessionId: string,
): TransferError {
  return new TransferError(
    `Duplicate upload blocked: remote key '${targetKey}' is already targeted by ` +
      `non-terminal session '${existingSessionId}'. ` +
      `Call resumeSession('${existingSessionId}') to continue that upload, ` +
      `or cancel it before starting a new one.`,
    "duplicateUpload",
    undefined,
    undefined,
    existingSessionId,
  );
}
