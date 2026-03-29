/**
 * @module ResumeStore
 *
 * Persists download session state to disk as atomic JSON files.
 *
 * Write strategy:
 *   1. Serialise to JSON.
 *   2. Write to a `.tmp` side-file.
 *   3. Rename the `.tmp` to the final path.
 *
 * This rename is atomic on POSIX (Linux, macOS) and near-atomic on Windows
 * (NTFS). A crash during step 2 leaves the `.tmp` behind — the previous
 * good state is intact. A crash during step 3 at worst leaves the `.tmp`
 * with the new state, which we detect and recover on next load.
 *
 * File naming: `<id>.json` inside the configured storeDir.
 */

import * as fs from "fs";
import * as path from "path";
import type { DownloadSession } from "./types.js";

/** Returns true only for "file not found" errors. */
function isENOENT(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

export class ResumeStore {
  private readonly _dir: string;

  constructor(storeDir: string) {
    this._dir = storeDir;
  }

  async save(session: DownloadSession): Promise<void> {
    await fs.promises.mkdir(this._dir, { recursive: true });
    const finalPath = this._sessionPath(session.id);
    const tmpPath = finalPath + ".tmp";
    const json = JSON.stringify({ ...session, updatedAt: Date.now() }, null, 2);
    await fs.promises.writeFile(tmpPath, json, "utf8");
    await fs.promises.rename(tmpPath, finalPath);
  }

  async load(id: string): Promise<DownloadSession | null> {
    const p = this._sessionPath(id);
    try {
      const raw = await fs.promises.readFile(p, "utf8");
      return JSON.parse(raw) as DownloadSession;
    } catch (err) {
      // Only swallow "file not found" or JSON corruption.
      // Re-throw permission errors, disk errors, etc. so callers see real failures
      // instead of silently falling back to stale recovery data.
      if (!isENOENT(err) && !(err instanceof SyntaxError)) throw err;
      // Try the .tmp recovery path (crash during rename leaves this behind)
      try {
        const raw = await fs.promises.readFile(p + ".tmp", "utf8");
        return JSON.parse(raw) as DownloadSession;
      } catch (tmpErr) {
        if (!isENOENT(tmpErr) && !(tmpErr instanceof SyntaxError)) throw tmpErr;
        return null;
      }
    }
  }

  async listAll(): Promise<DownloadSession[]> {
    let files: string[];
    try {
      files = await fs.promises.readdir(this._dir);
    } catch {
      return [];
    }
    const sessions: DownloadSession[] = [];
    for (const f of files) {
      if (!f.endsWith(".json") || f.endsWith(".tmp.json")) continue;
      const id = f.replace(/\.json$/, "");
      const s = await this.load(id);
      if (s) sessions.push(s);
    }
    return sessions;
  }

  async delete(id: string): Promise<void> {
    const p = this._sessionPath(id);
    await fs.promises.unlink(p).catch(() => undefined);
    await fs.promises.unlink(p + ".tmp").catch(() => undefined);
  }

  private _sessionPath(id: string): string {
    // Sanitise id to prevent directory traversal
    const safe = id.replace(/[^a-zA-Z0-9_\-]/g, "_");
    return path.join(this._dir, `${safe}.json`);
  }
}
