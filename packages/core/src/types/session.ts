/**
 * @module types/session
 *
 * TransferSession is the top-level unit of work tracked by the SDK.
 * It encapsulates everything needed to resume, retry, or cancel a transfer.
 *
 * Invariants:
 *   - id is stable across restarts (must equal the key used in the state store)
 *   - totalSize === sum(chunk.size for all chunks)
 *   - transferredBytes never exceeds totalSize
 *   - chunks.length === Math.ceil(totalSize / chunkSize) when totalSize > 0
 *   - A session in state 'done' cannot transition to any other state
 *   - A session in state 'cancelled' cannot transition to any other state
 */

import type { ChunkMeta } from "./chunk.js";

// ── Session lifecycle ────────────────────────────────────────────────────────

/**
 * Full state machine for a TransferSession.
 *
 * Valid transitions:
 *
 *   created    → initializing   (adapter.initTransfer called)
 *   initializing → queued       (adapter returned remote session id)
 *   queued     → running        (engine starts uploading chunks)
 *   running    → paused         (user calls pause())
 *   running    → done           (all chunks confirmed)
 *   running    → failed         (unrecoverable error)
 *   paused     → reconciling    (user calls resume() — reconcile before continuing)
 *   failed     → reconciling    (user calls resume() after failure)
 *   reconciling → running       (reconcile complete, re-queue pending chunks)
 *   reconciling → failed        (reconcile itself failed)
 *   paused     → cancelled      (user calls cancel())
 *   failed     → cancelled      (user calls cancel())
 *   queued     → cancelled      (user calls cancel() before start)
 *   running    → cancelled      (user calls cancel())
 */
export type SessionState =
  | "created" // built in memory, not yet persisted or sent to adapter
  | "initializing" // adapter.initTransfer in-flight
  | "queued" // ready to run, waiting for concurrency slot in queue
  | "running" // chunks being actively transferred
  | "paused" // user-initiated pause
  | "reconciling" // comparing local vs remote state before resuming
  | "failed" // at least one chunk reached fatal state
  | "done" // all chunks confirmed by remote
  | "cancelled"; // user cancelled — terminal state

export const TERMINAL_STATES = new Set<SessionState>([
  "done",
  "cancelled",
  "failed",
]);
export const RESUMABLE_STATES = new Set<SessionState>([
  "paused",
  "failed",
  "running", // engine crashed mid-flight
]);

// ── Transfer direction ───────────────────────────────────────────────────────

/**
 * Currently only upload is implemented.
 * Download is reserved for a future release and will throw "not implemented" if attempted.
 */
export type TransferDirection = "upload";

// ── File source descriptor ───────────────────────────────────────────────────

/**
 * Describes the source (upload) or destination (download) of a transfer.
 * Kept minimal so it works across Node (path-based) and Browser (File/Blob).
 */
export interface FileDescriptor {
  /** Human-readable name used in logs and UI. */
  name: string;
  /** Total byte size of the file. */
  size: number;
  /** MIME type if known; may be empty string. */
  mimeType: string;
  /**
   * Node: absolute file path.
   * Browser: left empty — caller provides a Blob handle separately.
   */
  path?: string;
  /**
   * Last-modified timestamp in milliseconds (from `fs.stat().mtimeMs`) at the
   * time the session was created. When provided and `UploadEngineOptions.fileStatFn`
   * is set, the engine checks this on resume and throws `fileChangedError` if the
   * file has been modified since the session was created.
   */
  mtimeMs?: number;
}

// ── The session itself ───────────────────────────────────────────────────────

export interface TransferSession {
  /** Stable unique identifier. Used as primary key in state stores. */
  readonly id: string;
  readonly direction: TransferDirection;
  readonly file: FileDescriptor;

  /**
   * Remote object key (path) on the storage provider.
   * E.g. "uploads/2024/video.mp4" for B2/S3.
   */
  readonly targetKey: string;

  /**
   * Chunk size in bytes used to split this file.
   * Stored so the engine can reconstruct byte ranges on resume.
   */
  readonly chunkSize: number;

  /** Ordered array of all chunks. Length must equal ceil(file.size / chunkSize). */
  chunks: ChunkMeta[];

  /** Current lifecycle state. */
  state: SessionState;

  /**
   * Opaque provider identifier returned by adapter.initTransfer().
   * E.g. B2 fileId, S3 uploadId.
   */
  providerSessionId?: string;

  /** Epoch ms when the session was created. */
  readonly createdAt: number;

  /** Epoch ms of the last state transition. Updated on every state change. */
  updatedAt: number;

  /**
   * Cumulative bytes confirmed by the storage provider.
   * Derived from chunks in 'done' state, cached here for fast reads.
   */
  transferredBytes: number;

  /** Number of times the full session has been retried after failure. */
  sessionRetries: number;
}

// ── State transition guard ───────────────────────────────────────────────────

/** All valid (from → to) transitions. */
const VALID_TRANSITIONS = new Map<SessionState, ReadonlySet<SessionState>>([
  ["created", new Set(["initializing", "cancelled"])],
  ["initializing", new Set(["queued", "failed", "cancelled"])],
  ["queued", new Set(["running", "cancelled"])],
  [
    "running",
    new Set(["paused", "done", "failed", "cancelled", "reconciling"]),
  ],
  ["paused", new Set(["running", "reconciling", "cancelled"])],
  ["reconciling", new Set(["running", "done", "failed", "cancelled"])],
  ["failed", new Set(["queued", "reconciling", "cancelled"])],
  ["done", new Set()],
  ["cancelled", new Set()],
]);

/**
 * Transitions a session to a new state.
 * Throws if the transition is not permitted.
 * Updates `updatedAt` on every successful transition.
 */
export function transitionSession(
  session: TransferSession,
  next: SessionState,
): void {
  const allowed = VALID_TRANSITIONS.get(session.state);
  if (!allowed?.has(next)) {
    throw new Error(
      `[TransferX] Invalid session state transition: ${session.state} → ${next} (session=${session.id})`,
    );
  }
  session.state = next;
  session.updatedAt = Date.now();
}

// ── Derived helpers ──────────────────────────────────────────────────────────

export function getTransferredBytes(session: TransferSession): number {
  return session.chunks
    .filter((c) => c.status === "done")
    .reduce((acc, c) => acc + c.size, 0);
}

export function getProgressPercent(session: TransferSession): number {
  if (session.file.size === 0) return 100;
  return Math.min(
    100,
    (getTransferredBytes(session) / session.file.size) * 100,
  );
}

export function hasFatalChunks(session: TransferSession): boolean {
  return session.chunks.some((c) => c.status === "fatal");
}

export function allChunksDone(session: TransferSession): boolean {
  return (
    session.chunks.length > 0 &&
    session.chunks.every((c) => c.status === "done")
  );
}
