/**
 * @module DownloadManager
 *
 * Global coordinator that limits the number of concurrently active downloads.
 *
 * Problem solved:
 *   DownloadEngine instances are completely independent. Starting 100 of them
 *   simultaneously opens up to 3 200 sockets + 100 FileWriter file descriptors,
 *   which can exhaust OS limits (EMFILE / OOM) and starve the event loop.
 *
 * Design:
 *   - maxConcurrentDownloads cap (default: 3) — same spirit as TransferManager.
 *   - Fair FIFO queue: first-enqueued, first-started.
 *   - Auto-drain: when a download finishes (success or failure), the next
 *     queued download starts automatically.
 *   - pauseAll() / resumeAll() / cancelAll() affect active downloads.
 *   - getStatus() for observability (no I/O).
 *
 * Usage:
 *   ```typescript
 *   const manager = new DownloadManager({ maxConcurrentDownloads: 3 });
 *
 *   const { task, promise } = manager.enqueue(url, outputPath);
 *   task.on('progress', p => console.log(p.percent));
 *   const session = await promise;   // resolves when download completes
 *   ```
 */

import { DownloadEngine } from "./DownloadEngine.js";
import { DownloadTask } from "./DownloadTask.js";
import type { DownloadEngineTask } from "./DownloadEngine.js";
import type { DownloadConfig, DownloadSession } from "./types.js";

// ── Public interfaces ─────────────────────────────────────────────────────────

export interface DownloadManagerOptions {
  /** Maximum concurrent active downloads. Default: 3 */
  maxConcurrentDownloads?: number;
  /** Engine config applied to all downloads managed here. */
  config?: Partial<DownloadConfig>;
  /** Session persistence directory. Default: .transferx-downloads */
  storeDir?: string;
}

/**
 * Returned by enqueue(): a task (for event subscriptions) plus a promise
 * that resolves when the download completes or rejects on failure.
 */
export interface ManagedDownload {
  /** Subscribe to progress, retry, log, completed, error events. */
  readonly task: DownloadTask;
  /**
   * Resolves with the final DownloadSession on success.
   * Rejects with DownloadError on failure (after retries exhausted).
   */
  readonly promise: Promise<DownloadSession>;
}

export interface DownloadManagerStatus {
  /** Number of downloads currently running. */
  active: number;
  /** Number of downloads waiting for a slot. */
  queued: number;
  maxConcurrent: number;
}

// ── Internal queue entry ──────────────────────────────────────────────────────

interface QueueEntry {
  inner: DownloadEngineTask;
  resolve: (session: DownloadSession) => void;
  reject: (err: unknown) => void;
}

// ── DownloadManager ───────────────────────────────────────────────────────────

export class DownloadManager {
  private readonly _engine: DownloadEngine;
  private readonly _maxConcurrent: number;
  private _active: number = 0;
  private readonly _queue: QueueEntry[] = [];
  private readonly _activeTasks: Set<DownloadEngineTask> = new Set();

  constructor(opts: DownloadManagerOptions = {}) {
    this._maxConcurrent = Math.max(1, opts.maxConcurrentDownloads ?? 3);
    const engineOpts: { config?: Partial<DownloadConfig>; storeDir?: string } = {};
    if (opts.config !== undefined) engineOpts.config = opts.config;
    if (opts.storeDir !== undefined) engineOpts.storeDir = opts.storeDir;
    this._engine = new DownloadEngine(engineOpts);
  }

  /**
   * Enqueue a new download.
   *
   * Returns immediately. The download starts automatically when a concurrency
   * slot becomes available (potentially right away if slots are free).
   *
   * @param url        Remote URL to download.
   * @param outputPath Absolute path for the output file.
   */
  enqueue(url: string, outputPath: string): ManagedDownload {
    const inner = this._engine.createTask(url, outputPath);
    return this._schedule(inner);
  }

  /**
   * Resume a persisted (crashed / cancelled) session.
   * Returns null when no session is stored for the given ID.
   */
  async resumeSession(sessionId: string): Promise<ManagedDownload | null> {
    const inner = await this._engine.resumeTask(sessionId);
    if (!inner) return null;
    return this._schedule(inner);
  }

  /**
   * List all persisted incomplete sessions from the underlying store.
   */
  async listSessions(): Promise<DownloadSession[]> {
    return this._engine.listSessions();
  }

  /**
   * Pause all downloads that are currently active.
   * Queued downloads are unaffected (they will start normally when a slot opens).
   */
  pauseAll(): void {
    for (const t of this._activeTasks) t.pause();
  }

  /**
   * Resume all paused active downloads.
   */
  resumeAll(): void {
    for (const t of this._activeTasks) t.resume();
  }

  /**
   * Cancel all active downloads and reject all queued promises.
   * The underlying session files remain on disk for later resumption.
   */
  async cancelAll(): Promise<void> {
    // Reject queued — they haven't started yet
    const pending = this._queue.splice(0);
    for (const entry of pending) {
      entry.reject(new Error("DownloadManager: cancelAll() called"));
    }

    // Cancel active
    const cancels = [...this._activeTasks].map((t) => t.cancel());
    await Promise.allSettled(cancels);
  }

  /**
   * Lightweight status snapshot (no I/O).
   */
  getStatus(): DownloadManagerStatus {
    return {
      active: this._active,
      queued: this._queue.length,
      maxConcurrent: this._maxConcurrent,
    };
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private _schedule(inner: DownloadEngineTask): ManagedDownload {
    const task = new DownloadTask(inner);
    const promise = new Promise<DownloadSession>((resolve, reject) => {
      this._queue.push({ inner, resolve, reject });
    });
    this._drain();
    return { task, promise };
  }

  private _drain(): void {
    while (this._active < this._maxConcurrent && this._queue.length > 0) {
      const entry = this._queue.shift()!;
      this._active++;
      this._activeTasks.add(entry.inner);

      void entry.inner
        .start()
        .then((result) => entry.resolve(result.session))
        .catch((err) => entry.reject(err))
        .finally(() => {
          this._active--;
          this._activeTasks.delete(entry.inner);
          // Fill the freed slot with the next queued download.
          this._drain();
        });
    }
  }
}
