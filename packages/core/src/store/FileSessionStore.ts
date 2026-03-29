/**
 * @module store/FileSessionStore
 *
 * Node.js file-backed durable session store.
 *
 * Layout on disk:
 *   <storeDir>/
 *     <sessionId>.json        ← canonical session snapshot
 *     <sessionId>.json.tmp    ← atomic write staging file
 *
 * Crash-safety strategy (atomic write):
 *   1. Serialise session to JSON.
 *   2. Write to <id>.json.tmp (partial writes cannot corrupt the live file).
 *   3. fs.rename(<id>.json.tmp, <id>.json)   ← atomic on POSIX; best-effort on Windows.
 *   On Windows, rename over an existing file is not guaranteed atomic by the OS
 *   but Node's fs.rename() calls MoveFileExW with MOVEFILE_REPLACE_EXISTING which
 *   is effectively atomic for our use-case on NTFS.
 *
 * Corruption guard:
 *   load() wraps JSON.parse in a try/catch.  Corrupted files return `undefined`
 *   (treated as "session not found") and log a warning.  The corrupt file is
 *   NOT deleted automatically — operators can inspect it.
 *
 * Concurrency safety: inherited from the engine (no concurrent saves per session).
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { TransferSession } from "../types/session.js";
import type { ISessionStore } from "./ISessionStore.js";

export class FileSessionStore implements ISessionStore {
  private readonly _dir: string;

  constructor(storeDir: string) {
    this._dir = storeDir;
  }

  async save(session: TransferSession): Promise<void> {
    await this._ensureDir();
    const live = this._livePath(session.id);
    const tmp = `${live}.tmp`;
    const json = JSON.stringify(session, null, 2);
    await fs.writeFile(tmp, json, "utf8");
    await fs.rename(tmp, live); // atomic swap
  }

  async load(sessionId: string): Promise<TransferSession | undefined> {
    const live = this._livePath(sessionId);
    let raw: string;
    try {
      raw = await fs.readFile(live, "utf8");
    } catch (err: unknown) {
      if (isNotFound(err)) return undefined;
      throw err;
    }

    try {
      return JSON.parse(raw) as TransferSession;
    } catch {
      // Corrupted file — return undefined, preserve file for operator inspection
      console.warn(`[FileSessionStore] Corrupted session file: ${live}`);
      return undefined;
    }
  }

  async delete(sessionId: string): Promise<void> {
    const live = this._livePath(sessionId);
    try {
      await fs.unlink(live);
    } catch (err: unknown) {
      if (!isNotFound(err)) throw err;
      // Already gone — treat as success
    }
  }

  async listAll(): Promise<TransferSession[]> {
    await this._ensureDir();
    let entries: string[];
    try {
      entries = await fs.readdir(this._dir);
    } catch {
      return [];
    }

    const sessions: TransferSession[] = [];
    await Promise.all(
      entries
        .filter((f) => f.endsWith(".json") && !f.endsWith(".tmp"))
        .map(async (f) => {
          const sessionId = f.slice(0, -5); // strip '.json'
          const s = await this.load(sessionId);
          if (s) sessions.push(s);
        }),
    );
    return sessions;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private _livePath(sessionId: string): string {
    // Sanitise: only allow alphanumerics, dashes, underscores
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(this._dir, `${safe}.json`);
  }

  private async _ensureDir(): Promise<void> {
    await fs.mkdir(this._dir, { recursive: true });
  }
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}
