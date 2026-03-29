/**
 * @module scheduler/Scheduler
 *
 * The Scheduler is the concurrency control heart of TransferX.
 *
 * Responsibilities:
 *   1. Enforce a maximum number of concurrently executing tasks.
 *   2. Queue pending tasks and drain them as slots free up.
 *   3. Never lose a task — even if push() is called while full.
 *   4. Support priority queuing: retry tasks are front-queued.
 *   5. Allow dynamic concurrency adjustment (adaptive engine hooks in here).
 *   6. Provide pause/resume at the scheduler level.
 *
 * Design decisions:
 *   - Tasks are plain async functions (() => Promise<void>).
 *     The scheduler does not know about chunks or sessions — decoupled.
 *   - Concurrency = the hard cap on simultaneously active tasks.
 *   - The internal queue is a simple array; head = next to run.
 *     This is fine for the queue depths we expect (hundreds of chunks, not millions).
 *   - On error the scheduler itself does NOT retry — the retry engine
 *     wraps the task and handles that. The scheduler only cares about
 *     "how many are running right now".
 */

export type Task = () => Promise<void>;

export interface SchedulerStats {
  active: number;
  queued: number;
  concurrency: number;
  paused: boolean;
  totalExecuted: number;
  totalErrored: number;
}

export class Scheduler {
  private _concurrency: number;
  private _active = 0;
  private _paused = false;
  private _totalExecuted = 0;
  private _totalErrored = 0;

  /** Internal FIFO queue. Index 0 = next task to run. */
  private readonly _queue: Task[] = [];
  /** Whether the scheduler has been permanently shut down. */
  private _destroyed = false;
  /** Callbacks waiting for the scheduler to become idle (see drain()). */
  private readonly _drainCallbacks: Array<() => void> = [];

  constructor(concurrency: number) {
    this._concurrency = this._validateConcurrency(concurrency);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Enqueue a task at the BACK of the queue (normal priority).
   * Triggers a drain attempt.
   */
  push(task: Task): void {
    this._assertNotDestroyed();
    this._queue.push(task);
    this._drain();
  }

  /**
   * Enqueue a task at the FRONT of the queue (high priority, e.g. retries).
   * Triggers a drain attempt.
   */
  pushFront(task: Task): void {
    this._assertNotDestroyed();
    this._queue.unshift(task);
    this._drain();
  }

  /** Pause execution — currently running tasks finish, no new ones start. */
  pause(): void {
    this._paused = true;
  }

  /**
   * Resume execution after a pause.
   * Immediately triggers a drain so queued tasks start running.
   */
  resume(): void {
    this._paused = false;
    this._drain();
  }

  /**
   * Dynamically adjust the concurrency limit.
   * If raised: triggers a drain to fill new slots immediately.
   * If lowered: takes effect as active tasks finish.
   */
  setConcurrency(n: number): void {
    this._concurrency = this._validateConcurrency(n);
    this._drain();
  }

  /**
   * Drain the pending queue immediately (call after adding items externally).
   */
  flush(): void {
    this._drain();
  }

  /**
   * Returns a Promise that resolves when all queued and active tasks have
   * completed (the scheduler goes idle).
   *
   * If the scheduler is currently idle (active === 0 && queued === 0) the
   * promise resolves on the next microtask so that callers do not need to
   * special-case the already-idle scenario.
   *
   * Note: new tasks pushed AFTER drain() is called extend the drain window —
   * the returned promise will not resolve until those tasks also complete.
   */
  drain(): Promise<void> {
    if (this._active === 0 && this._queue.length === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this._drainCallbacks.push(resolve);
    });
  }

  /**
   * Clear all pending tasks from the queue WITHOUT running them.
   * Returns the number of tasks removed.
   */
  clear(): number {
    const removed = this._queue.length;
    this._queue.length = 0;
    return removed;
  }

  /** Permanently shut down the scheduler. No tasks can be added after this. */
  destroy(): void {
    this._destroyed = true;
    this._queue.length = 0;
  }

  get stats(): SchedulerStats {
    return {
      active: this._active,
      queued: this._queue.length,
      concurrency: this._concurrency,
      paused: this._paused,
      totalExecuted: this._totalExecuted,
      totalErrored: this._totalErrored,
    };
  }

  get concurrency(): number {
    return this._concurrency;
  }
  get active(): number {
    return this._active;
  }
  get queued(): number {
    return this._queue.length;
  }
  get paused(): boolean {
    return this._paused;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  /**
   * Core drain loop.
   * Called after every state change that may allow new tasks to run.
   * Runs synchronously — safe to call from anywhere.
   */
  private _drain(): void {
    if (!this._paused && !this._destroyed) {
      while (this._active < this._concurrency && this._queue.length > 0) {
        const task = this._queue.shift();
        if (!task) break;

        this._active += 1;

        // Run the task asynchronously; handle its completion to decrement active
        // and trigger another drain.
        void task().then(
          () => {
            this._active -= 1;
            this._totalExecuted += 1;
            this._drain();
          },
          (_err: unknown) => {
            // The task itself is responsible for error handling (retry engine wraps it).
            // The scheduler only needs to know the slot is free.
            this._active -= 1;
            this._totalErrored += 1;
            this._drain();
          },
        );
      }
    }

    // Notify drain() waiters when we go idle (regardless of paused state).
    // This allows callers that called pause() to still observe the drain completing.
    if (
      this._active === 0 &&
      this._queue.length === 0 &&
      this._drainCallbacks.length > 0
    ) {
      const callbacks = this._drainCallbacks.splice(0);
      for (const cb of callbacks) cb();
    }
  }

  private _assertNotDestroyed(): void {
    if (this._destroyed)
      throw new Error("[Scheduler] Cannot push tasks after destroy()");
  }

  private _validateConcurrency(n: number): number {
    if (!Number.isInteger(n) || n < 1) {
      throw new RangeError(`concurrency must be a positive integer, got ${n}`);
    }
    return n;
  }
}
