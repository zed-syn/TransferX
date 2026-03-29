/**
 * @module progress/ProgressEngine
 *
 * Accumulates confirmed-byte counts and emits throttled progress events.
 *
 * Design decisions:
 *
 * 1. EXPONENTIAL MOVING AVERAGE (EMA) for speed:
 *    Uses α = 0.2 so fast bursts don't dominate the reported speed,
 *    giving a smooth "bytes/sec" experience.
 *    α is exposed as a constructor option so tests can override it.
 *
 * 2. INTERVAL-BASED EMISSION:
 *    Rather than emitting on every confirmBytes() call, a setInterval
 *    fires every `progressIntervalMs` and emits one aggregate event.
 *    This bounds the event throughput regardless of chunk size.
 *
 * 3. NO FLOATING-POINT ACCUMULATION DRIFT:
 *    All byte counts are integers (bigint-safe via Number — files up to
 *    2^53 bytes ≈ 8 PiB are safe with Number).
 *
 * 4. ETA SAFETY:
 *    Divide-by-zero is guarded: when speed ≤ 0 the ETA is undefined
 *    rather than Infinity, which is a more useful API contract.
 *
 * 5. LIFECYCLE:
 *    start() → confirmBytes()* → stop()
 *    After stop() further confirmBytes() calls are ignored silently.
 */

import type { TransferProgress } from "../types/events.js";

export interface ProgressEngineOptions {
  /** Total file size in bytes. */
  totalBytes: number;
  /** Session identifier to embed in emitted progress objects. */
  sessionId: string;
  /** How often (ms) to fire the emit callback. Default: 200 ms. */
  intervalMs?: number;
  /**
   * EMA smoothing factor α ∈ (0, 1].
   * Higher α → more reactive; lower → smoother.
   * Default: 0.2
   */
  alpha?: number;
  /** Called with each progress snapshot. */
  onProgress: (progress: TransferProgress) => void;
}

export class ProgressEngine {
  private readonly _totalBytes: number;
  private readonly _sessionId: string;
  private readonly _intervalMs: number;
  private readonly _alpha: number;
  private readonly _onProgress: (p: TransferProgress) => void;

  private _confirmedBytes = 0;
  private _smoothedSpeedBps = 0; // EMA of bytes/sec
  private _lastTick = 0; // timestamp of previous tick (ms)
  private _lastConfirmed = 0; // confirmedBytes at previous tick
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _stopped = false;

  constructor(options: ProgressEngineOptions) {
    this._totalBytes = options.totalBytes;
    this._sessionId = options.sessionId;
    this._intervalMs = options.intervalMs ?? 200;
    this._alpha = options.alpha ?? 0.2;
    this._onProgress = options.onProgress;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Begin the periodic progress emission timer.
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  start(): void {
    if (this._timer !== null || this._stopped) return;
    this._lastTick = Date.now();
    this._lastConfirmed = this._confirmedBytes;
    this._timer = setInterval(() => this._tick(), this._intervalMs);
  }

  /**
   * Inform the engine that `bytes` additional bytes have been confirmed
   * (successfully uploaded / downloaded) for the given session.
   */
  confirmBytes(bytes: number): void {
    if (this._stopped) return;
    this._confirmedBytes += bytes;
  }

  /**
   * Stop the timer and emit one final progress snapshot.
   */
  stop(): void {
    if (this._stopped) return;
    this._stopped = true;
    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }
    // Emit final snapshot (100% when done, or whatever reached)
    this._emitSnapshot();
  }

  /** Current snapshot — available without starting the timer. */
  snapshot(): TransferProgress {
    return this._buildSnapshot();
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private _tick(): void {
    const now = Date.now();
    const elapsedMs = now - this._lastTick;
    if (elapsedMs <= 0) return;

    const deltaBytes = this._confirmedBytes - this._lastConfirmed;
    const instantSpeed = (deltaBytes / elapsedMs) * 1000; // bytes/sec

    // EMA: smooth = α * instant + (1-α) * prev
    this._smoothedSpeedBps =
      this._alpha * instantSpeed + (1 - this._alpha) * this._smoothedSpeedBps;

    this._lastTick = now;
    this._lastConfirmed = this._confirmedBytes;

    this._emitSnapshot();
  }

  private _emitSnapshot(): void {
    this._onProgress(this._buildSnapshot());
  }

  private _buildSnapshot(): TransferProgress {
    const percent =
      this._totalBytes > 0
        ? Math.min(
            100,
            Math.floor((this._confirmedBytes / this._totalBytes) * 100),
          )
        : 100; // Zero-byte file is always "done"

    const eta =
      this._smoothedSpeedBps > 0
        ? Math.ceil(
            (this._totalBytes - this._confirmedBytes) / this._smoothedSpeedBps,
          )
        : undefined;

    return {
      sessionId: this._sessionId,
      percent,
      transferredBytes: this._confirmedBytes,
      totalBytes: this._totalBytes,
      speedBytesPerSec: Math.floor(this._smoothedSpeedBps),
      etaSeconds: eta,
    };
  }
}
