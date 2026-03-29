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
 * Adaptive concurrency — two-signal hill-climbing:
 *   Error-rate gate (existing):
 *     recordSuccess() / recordFailure() feed a sliding window of WINDOW_SIZE
 *     outcomes. errorRate > HIGH_THRESHOLD → scale down immediately.
 *
 *   Throughput gate (new in v1.2.0):
 *     addThroughputSample(bytesPerMs) feeds a separate THROUGHPUT_WINDOW_SIZE
 *     rolling window. Scale-up is gated on measured throughput having improved
 *     vs the median at the last scale-up event. This prevents wasting connections
 *     on a saturated server that shows low error rate but no speed gain.
 *
 *   Combined policy:
 *     scale-down: errorRate > HIGH_THRESHOLD  (fast, no throughput check)
 *     scale-up:   errorRate < LOW_THRESHOLD
 *                 AND stableSuccessStreak >= SCALE_UP_COUNT
 *                 AND currentThroughput > lastScaleUpThroughput × (1 + IMPROVEMENT_MIN)
 *                 AND at least COOLDOWN_MS since last adjustment
 *
 * The scheduler is decoupled from HTTP: a "task" is any () => Promise<void>.
 */

import type { ConcurrencyPolicy } from "./types.js";

type Task = () => Promise<void>;

// ── Adaptive constants ────────────────────────────────────────────────────────
const HIGH_ERROR_RATE = 0.3; // reduce concurrency when error rate > 30 %
const LOW_ERROR_RATE = 0.05; // increase concurrency when error rate < 5 %
const WINDOW_SIZE = 20; // sliding window sample count for error rate
const COOLDOWN_MS = 3_000; // min ms between concurrency adjustments
const SCALE_UP_COUNT = 10; // stable successes required before scale-up attempt

// Throughput hill-climbing constants
const THROUGHPUT_WINDOW_SIZE = 10; // rolling median window (chunk samples)
const THROUGHPUT_IMPROVEMENT_MIN = 0.05; // need ≥ 5 % improvement to justify scale-up

export class ChunkScheduler {
  private readonly _policy: ConcurrencyPolicy;

  // Concurrency state
  private _limit: number;
  private _active: number;
  private _paused: boolean;
  private _cancelled: boolean;

  // Queue
  private readonly _queue: Task[];

  // Drain waiters
  private _drainResolvers: Array<() => void>;

  // Error-rate adaptive state
  private readonly _window: boolean[];
  private _lastAdjustTime: number;
  private _stableSuccessStreak: number;

  // Throughput hill-climbing state
  private readonly _tpWindow: number[]; // bytes/ms per chunk
  private _tpAtLastScaleUp: number; // median bytes/ms at last scale-up event

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
    this._tpWindow = [];
    this._tpAtLastScaleUp = 0;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /** Enqueue a task at the back of the queue. */
  push(task: Task): void {
    if (this._cancelled) return;
    this._queue.push(task);
    this._dispatch();
  }

  /** Enqueue a task at the FRONT (higher priority — e.g. for retries). */
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
   */
  async cancel(): Promise<void> {
    this._cancelled = true;
    this._queue.length = 0;
    return this.drain();
  }

  /**
   * Resolves when the queue is empty AND active count reaches zero.
   */
  drain(): Promise<void> {
    if (this._active === 0 && this._queue.length === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this._drainResolvers.push(resolve);
    });
  }

  /** Feed error-rate signal. Call after each chunk attempt regardless of outcome. */
  recordSuccess(): void {
    this._recordOutcome(true);
  }

  /** Feed error-rate signal. Call after each chunk failure. */
  recordFailure(): void {
    this._recordOutcome(false);
  }

  /**
   * Feed throughput signal for hill-climbing.
   * Call after each successfully completed chunk download.
   *
   * @param bytesPerMs  Bytes downloaded divided by elapsed milliseconds for
   *                    this chunk (including any resume offset re-download).
   *                    Pass 0 or negative to skip (e.g. for streaming chunks).
   */
  addThroughputSample(bytesPerMs: number): void {
    if (!this._policy.adaptive || bytesPerMs <= 0) return;
    this._tpWindow.push(bytesPerMs);
    if (this._tpWindow.length > THROUGHPUT_WINDOW_SIZE) this._tpWindow.shift();
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
      void task()
        .catch(() => {
          /* errors handled by engine */
        })
        .finally(() => {
          this._active--;
          this._dispatch();
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
    if (this._window.length < WINDOW_SIZE) return;

    const failures = this._window.filter((v) => !v).length;
    const errorRate = failures / this._window.length;

    if (errorRate > HIGH_ERROR_RATE) {
      // Error rate too high — scale down immediately, no throughput check.
      const next = Math.max(this._policy.min, this._limit - 1);
      if (next !== this._limit) {
        this._limit = next;
        this._lastAdjustTime = now;
        this._stableSuccessStreak = 0;
        // Reset throughput baseline so the next scale-up starts fresh.
        this._tpAtLastScaleUp = 0;
      }
    } else if (errorRate < LOW_ERROR_RATE) {
      this._stableSuccessStreak++;
      if (this._stableSuccessStreak >= SCALE_UP_COUNT) {
        // Throughput gate: only scale up if adding a connection demonstrably
        // improved throughput vs the last time we scaled up.
        const currentTp = this._medianThroughput();
        const hasBaseline = this._tpAtLastScaleUp > 0;
        const tpImproved =
          !hasBaseline ||
          currentTp >=
            this._tpAtLastScaleUp * (1 + THROUGHPUT_IMPROVEMENT_MIN);

        if (tpImproved) {
          const next = Math.min(this._policy.max, this._limit + 1);
          if (next !== this._limit) {
            this._limit = next;
            this._lastAdjustTime = now;
            this._tpAtLastScaleUp = currentTp;
          }
        }
        this._stableSuccessStreak = 0;
      }
    } else {
      // Neutral zone — reset streak but don't change limit.
      this._stableSuccessStreak = 0;
    }
  }

  /** Median throughput of the current rolling window. */
  private _medianThroughput(): number {
    if (this._tpWindow.length === 0) return 0;
    const sorted = [...this._tpWindow].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[mid - 1]! + sorted[mid]!) / 2
      : sorted[mid]!;
  }
}
