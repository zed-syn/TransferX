/**
 * @module store/ISessionStore
 *
 * Storage abstraction for durable session state.
 *
 * Implementations:
 *   - MemorySessionStore   — ephemeral, unit tests & in-process use
 *   - FileSessionStore     — Node.js file-backed, survives process restarts
 *   - IndexedDbSessionStore (future) — browser-side durable store
 *
 * Design philosophy:
 *   The store is intentionally narrow: save/load/delete/list.
 *   Business logic (state machine transitions, progress math) lives in
 *   the engine — not here.  The store is a pure persistence boundary.
 *
 * Concurrency safety:
 *   Callers MUST NOT issue concurrent save() calls for the same sessionId.
 *   The engine serialises writes per session via the Scheduler + a per-session
 *   write-lock (see UploadEngine).  In-flight reads are always safe.
 */

import type { TransferSession } from "../types/session.js";

export interface ISessionStore {
  /**
   * Persist or overwrite the session snapshot.
   * Should be called after every meaningful state change.
   */
  save(session: TransferSession): Promise<void>;

  /**
   * Load the snapshot for `sessionId`.
   * @returns the session, or `undefined` if not found.
   */
  load(sessionId: string): Promise<TransferSession | undefined>;

  /**
   * Permanently remove the session from storage.
   * No-op if the session does not exist.
   */
  delete(sessionId: string): Promise<void>;

  /**
   * Return all stored sessions.
   * Used by the Queue Manager on startup to resume in-flight sessions.
   */
  listAll(): Promise<TransferSession[]>;
}
