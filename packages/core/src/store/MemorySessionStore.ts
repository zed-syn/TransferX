/**
 * @module store/MemorySessionStore
 *
 * Ephemeral in-memory session store backed by a Map.
 *
 * Primary uses:
 *  1. Unit tests — no disk I/O, zero teardown cost.
 *  2. Short-lived CLI uploads where persistence is not required.
 *
 * Thread-safety: JavaScript is single-threaded; the Map operations are
 * synchronous, so no additional locking is needed.  Async wrappers are
 * provided purely to satisfy ISessionStore's async contract.
 */

import type { TransferSession } from "../types/session.js";
import type { ISessionStore } from "./ISessionStore.js";

export class MemorySessionStore implements ISessionStore {
  private readonly _map = new Map<string, TransferSession>();

  async save(session: TransferSession): Promise<void> {
    // Shallow-clone to prevent external mutation of stored state
    this._map.set(session.id, {
      ...session,
      chunks: session.chunks.map((c) => ({ ...c })),
    });
  }

  async load(sessionId: string): Promise<TransferSession | undefined> {
    const stored = this._map.get(sessionId);
    if (!stored) return undefined;
    return { ...stored, chunks: stored.chunks.map((c) => ({ ...c })) };
  }

  async delete(sessionId: string): Promise<void> {
    this._map.delete(sessionId);
  }

  async listAll(): Promise<TransferSession[]> {
    return Array.from(this._map.values()).map((s) => ({
      ...s,
      chunks: s.chunks.map((c) => ({ ...c })),
    }));
  }

  /** Test utility: how many sessions are currently stored. */
  get size(): number {
    return this._map.size;
  }

  /** Test utility: discard all stored sessions. */
  clear(): void {
    this._map.clear();
  }
}
