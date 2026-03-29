/**
 * @module ChunkScheduler
 *
 * Concurrency-limited task queue for parallel range downloads.
 *
 * Design:
 *   - Maintains a pending FIFO queue and an active slot pool.
 *   - Dispatches the next pending task whenever an active slot becomes free.
 *   - pause() stops new dispatches; existing active tasks run to completion.
 *   - resume() re-opens dispatch.
 *   - cancel() drains the queue without running pending tasks and waits for
 *     active tasks to settle (via their own per-chunk AbortSignal).
 *   - drain() resolves when the queue is empty AND all active tasks complete.
 *
 * Adaptive concurrency:
 *   - recordSuccess() and recordFailure() feed a sliding error-rate window.
 *   - When errorRate > HIGH_THRESHOLD the limit drops by 1 (floor = min).
 *   - When errorRate < LOW_THRESHOLD after SCALE_UP_WINDOW stable samples the
 *     limit rises by 1 (ceiling = max).
 *   - Prevents oscillation by enforcing a minimum gap of COOLDOWN_MS between
 *     consecutive concurrency changes.
 *
 * The scheduler is decoupled from HTTP: a "task" is any () => Promise<void>.
 * The DownloadEngine wraps each chunk download in a task function.
 */

import type { ConcurrencyPolicy } from "./types.js";

type Task = () => Promise<void>;

// Adaptive concurrency thresholds
const HIGH_ERROR_RATE = 0.3; // reduce concurrency when error rate > 30%
const LOW_ERROR_RATE = 0.05; // increase concurrency when error rate < 5%
const WINDOW_SIZE = 20; // sliding window sample count
const COOLDOWN_MS = 3_000; // min ms between concurrency adjustments
const SCALE_UP_COUNT = 10; // stable successes required before scale-up

export class ChunkScheduler {
  private readonly _policy: ConcurrencyPolicy;

  // Concurrency state
  private _limit: number; // current active slot ceiling
  private _active: number; // tasks currently running
  private _paused: boolean;
  private _cancelled: boolean;

  // Queue
  private readonly _queue: Task[];

  // Drain waiters: resolve when active===0 && queue empty
  private _drainResolvers: Array<() => void>;

  // Adaptive state
  private readonly _window: boolean[]; // true=success, false=failure
  private _lastAdjustTime: number;
  private _stableSuccessStreak: number;

  constructor(policy: ConcurrencyPolicy) {
    this._policy = policy;
    this._limit = policy.initial;
    this._active = 0;
    this._paused = false;
    this._cancelled = false;
    this._queue = [];
    this._drainResolvers = [];
    this._window = [];
    this._lastAdjustTime = 0;
    this._stableSuccessStreak = 0;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /** Enqueue a task at the back of the queue. */
  push(task: Task): void {
    if (this._cancelled) return;
    this._queue.push(task);
    this._dispatch();
  }

  /** Enqueue a task at the FRONT (used for retries — higher priority). */
  pushFront(task: Task): void {
    if (this._cancelled) return;
    this._queue.unshift(task);
    this._dispatch();
  }

  /** Stop dispatching new tasks. Active tasks continue to completion. */
  pause(): void {
    this._paused = true;
  }

  /** Resume dispatching. */
  resume(): void {
    if (!this._paused) return;
    this._paused = false;
    this._dispatch();
  }

  /**
   * Cancel: clear the queue and mark as cancelled.
   * Returns a promise that resolves when all currently active tasks settle.
   * New push() calls are no-ops after cancel().
   */
  async cancel(): Promise<void> {
    this._cancelled = true;
    this._queue.length = 0;
    return this.drain();
  }

  /**
   * Resolves when the queue is empty AND active count reaches zero.
   * If the scheduler is paused with tasks in the queue, drain() will not
   * resolve until those tasks are eventually dispatched — call resume() first.
   */
  drain(): Promise<void> {
    if (this._active === 0 && this._queue.length === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this._drainResolvers.push(resolve);
    });
  }

  /** Feed outcome to adaptive algorithm. Call after each chunk completes. */
  recordSuccess(): void {
    this._recordOutcome(true);
  }

  /** Feed outcome to adaptive algorithm. Call after each chunk fails. */
  recordFailure(): void {
    this._recordOutcome(false);
  }

  get activeCount(): number {
    return this._active;
  }
  get queueLength(): number {
    return this._queue.length;
  }
  get currentLimit(): number {
    return this._limit;
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  private _dispatch(): void {
    while (
      !this._paused &&
      !this._cancelled &&
      this._active < this._limit &&
      this._queue.length > 0
    ) {
      const task = this._queue.shift()!;
      this._active++;
      // Run the task asynchronously — errors are handled inside the task
      // (DownloadEngine wraps chunks in withRetry, so errors are contained).
      // We intentionally catch here so a leaked rejection never crashes the
      // process.
      void task()
        .catch(() => {
          /* error handled by engine */
        })
        .finally(() => {
          this._active--;
          this._dispatch(); // fill newly freed slot
          this._checkDrain();
        });
    }
    this._checkDrain();
  }

  private _checkDrain(): void {
    if (this._active === 0 && this._queue.length === 0) {
      const resolvers = this._drainResolvers.splice(0);
      for (const resolve of resolvers) resolve();
    }
  }

  private _recordOutcome(success: boolean): void {
    if (!this._policy.adaptive) return;

    this._window.push(success);
    if (this._window.length > WINDOW_SIZE) this._window.shift();

    const now = Date.now();
    if (now - this._lastAdjustTime < COOLDOWN_MS) return;
    if (this._window.length < WINDOW_SIZE) return; // not enough data yet

    const failures = this._window.filter((v) => !v).length;
    const errorRate = failures / this._window.length;

    if (errorRate > HIGH_ERROR_RATE) {
      const next = Math.max(this._policy.min, this._limit - 1);
      if (next !== this._limit) {
        this._limit = next;
        this._lastAdjustTime = now;
        this._stableSuccessStreak = 0;
      }
    } else if (errorRate < LOW_ERROR_RATE) {
      this._stableSuccessStreak++;
      if (this._stableSuccessStreak >= SCALE_UP_COUNT) {
        const next = Math.min(this._policy.max, this._limit + 1);
        if (next !== this._limit) {
          this._limit = next;
          this._lastAdjustTime = now;
        }
        this._stableSuccessStreak = 0;
      }
    } else {
      // neutral zone — reset streak but don't change limit
      this._stableSuccessStreak = 0;
    }
  }
}
