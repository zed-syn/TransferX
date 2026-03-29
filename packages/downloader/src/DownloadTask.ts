/**
 * @module DownloadTask
 *
 * Public-facing task object returned to callers.
 *
 * Wraps the DownloadEngine's internal task and exposes a clean, stable API
 * that follows the same EventEmitter-style pattern used in @transferx/core.
 *
 * Usage:
 *
 *   const task = engine.createTask(url, outputPath);
 *   task.on('progress', p => console.log(p.percent));
 *   task.on('completed', ({ session }) => console.log('done'));
 *   await task.start();
 *
 * Event types mirror DownloadEventMap from types.ts.
 *
 * start() and cancel() return Promises:
 *   - start() resolves when the download completes (all bytes on disk, fsynced)
 *   - start() rejects with DownloadError on any unrecoverable failure
 *   - cancel() resolves when all in-flight chunks have settled
 *
 * pause() / resume() are synchronous — they affect the scheduler immediately.
 *
 * Calling start() a second time on a completed/failed task throws. Create a
 * new task via engine.createTask() for a retry.
 */

import { DownloadEngine } from "./DownloadEngine.js";
import type { DownloadEngineTask, DownloadResult } from "./DownloadEngine.js";
import type {
  DownloadConfig,
  DownloadEventHandler,
  DownloadEventMap,
  DownloadEventType,
  DownloadProgress,
  DownloadSession,
} from "./types.js";

export class DownloadTask {
  private readonly _inner: DownloadEngineTask;
  private _started: boolean = false;

  /** @internal — use DownloadEngine.createTask() to create instances. */
  constructor(inner: DownloadEngineTask) {
    this._inner = inner;
  }

  // ─── Event subscription ──────────────────────────────────────────────────

  on<K extends DownloadEventType>(
    event: K,
    handler: DownloadEventHandler<K>,
  ): this {
    this._inner.bus.on(event, handler);
    return this;
  }

  off<K extends DownloadEventType>(
    event: K,
    handler: DownloadEventHandler<K>,
  ): this {
    this._inner.bus.off(event, handler);
    return this;
  }

  // ─── Control ─────────────────────────────────────────────────────────────

  /**
   * Begin (or restart from a persisted session) the download.
   *
   * Resolves with the completed DownloadSession.
   * Rejects with DownloadError on unrecoverable failure.
   *
   * @throws {DownloadError} if download fails after exhausting retries
   * @throws {Error} if start() is called a second time
   */
  async start(): Promise<DownloadSession> {
    if (this._started) {
      throw new Error(
        "DownloadTask: start() already called. Create a new task to retry.",
      );
    }
    this._started = true;
    const result: DownloadResult = await this._inner.start();
    return result.session;
  }

  /**
   * Pause dispatching of new chunks. In-flight chunk fetches run to
   * completion (or until their own timeout fires).
   * Safe to call multiple times.
   */
  pause(): void {
    this._inner.pause();
  }

  /**
   * Resume chunk dispatching after a pause().
   * No-op if not paused.
   */
  resume(): void {
    this._inner.resume();
  }

  /**
   * Cancel the download. In-flight requests are aborted via AbortSignal.
   * The partial session is kept on disk so the download may be resumed later
   * by calling engine.resumeTask(sessionId).
   *
   * Resolves when all active chunk operations have settled.
   */
  async cancel(): Promise<void> {
    return this._inner.cancel();
  }

  // ─── State inspection ────────────────────────────────────────────────────

  /** The unique session ID (stable across restarts for the same url+outputPath). */
  get id(): string {
    return this._inner.id;
  }

  /** Current in-memory session state. null before start() is called. */
  getSession(): DownloadSession | null {
    return this._inner.getSession();
  }
}

// ─── Convenience factory ──────────────────────────────────────────────────────

/**
 * Convenience function: creates an engine + task in one call with no factory
 * boilerplate. Equivalent to:
 *
 *   new DownloadEngine(opts).createTask(url, outputPath)
 *
 * @example
 * ```typescript
 * import { createDownloadTask } from '@transferx/downloader';
 *
 * const task = createDownloadTask('https://example.com/large.bin', '/tmp/large.bin', {
 *   config: { concurrency: { initial: 8 } },
 *   storeDir: './.transfers',
 * });
 *
 * task.on('progress', p => console.log(`${p.percent?.toFixed(1)}%`));
 * await task.start();
 * ```
 */
export function createDownloadTask(
  url: string,
  outputPath: string,
  opts: {
    config?: Partial<DownloadConfig>;
    storeDir?: string;
  } = {},
): DownloadTask {
  const engine = new DownloadEngine(opts);
  const inner = engine.createTask(url, outputPath);
  return new DownloadTask(inner);
}
