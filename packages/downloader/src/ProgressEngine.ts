/**
 * @module ProgressEngine
 *
 * Tracks download throughput and emits progress events on a fixed interval.
 *
 * Speed calculation:
 *   Uses an Exponential Moving Average (EMA) with α = 0.2 so short network
 *   bursts don't cause wild speed jumps. The EMA is computed on samples taken
 *   at the emission interval (default 200 ms), meaning each sample represents
 *   Δbytes / Δtime for that window.
 *
 *   EMA formula:  speed_n = α × sample_n + (1 - α) × speed_{n-1}
 *
 * Anti-noise rules:
 *   - Speed resets to 0 if no bytes arrived in the last 3 × progressIntervalMs.
 *   - ETA is null when speed = 0 or totalBytes is unknown.
 *   - Progress events are throttled to progressIntervalMs regardless of how
 *     fast addBytes() is called — protects callers from event floods.
 *
 * Thread safety:
 *   Node.js is single-threaded. addBytes() is called synchronously from the
 *   write callback, and the interval fires between event loop ticks, so there
 *   is no race condition on _pendingBytes.
 */

import type { DownloadProgress } from "./types.js";

const EMA_ALPHA = 0.2;

export class ProgressEngine {
  private readonly _taskId: string;
  private readonly _intervalMs: number;
  private readonly _onProgress: (progress: DownloadProgress) => void;

  private _totalBytes: number | null;
  private _downloadedBytes: number; // bytes confirmed written to disk
  private _pendingBytes: number; // bytes received since last emission
  private _lastEmitTime: number; // Date.now() at last emission
  private _lastByteTime: number; // Date.now() at last addBytes() call
  private _smoothedSpeed: number; // current EMA speed (bytes/sec)
  private _timer: NodeJS.Timeout | null;
  private _running: boolean;

  constructor(opts: {
    taskId: string;
    totalBytes: number | null;
    downloadedBytes?: number;
    progressIntervalMs?: number;
    onProgress: (progress: DownloadProgress) => void;
  }) {
    this._taskId = opts.taskId;
    this._totalBytes = opts.totalBytes;
    this._downloadedBytes = opts.downloadedBytes ?? 0;
    this._pendingBytes = 0;
    this._lastEmitTime = Date.now();
    this._lastByteTime = Date.now();
    this._smoothedSpeed = 0;
    this._intervalMs = opts.progressIntervalMs ?? 200;
    this._onProgress = opts.onProgress;
    this._timer = null;
    this._running = false;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  start(): void {
    if (this._running) return;
    this._running = true;
    this._lastEmitTime = Date.now();
    this._lastByteTime = Date.now();
    this._scheduleEmit();
  }

  stop(): void {
    this._running = false;
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  /** Stop interval and emit a final progress snapshot immediately. */
  finish(): void {
    this.stop();
    this._emit(true);
  }

  // ─── Data input ─────────────────────────────────────────────────────────────

  /**
   * Called by FileWriter after each successful disk write.
   * @param bytes  Number of bytes just confirmed on disk.
   */
  addBytes(bytes: number): void {
    this._downloadedBytes += bytes;
    this._pendingBytes += bytes;
    this._lastByteTime = Date.now();
  }

  /**
   * Update the known total file size (e.g. discovered from streaming response).
   * Only used for unknown-size downloads where Content-Length is absent from
   * the HEAD response but may appear in the GET response body.
   */
  setTotalBytes(total: number): void {
    this._totalBytes = total;
  }

  /** Snapshot the current progress without emitting. Used for getProgress(). */
  snapshot(): DownloadProgress {
    return this._buildPayload();
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  private _scheduleEmit(): void {
    if (!this._running) return;
    this._timer = setTimeout(() => {
      this._emit(false);
      this._scheduleEmit();
    }, this._intervalMs);
  }

  private _emit(isFinal: boolean): void {
    const now = Date.now();
    const elapsedSec = Math.max((now - this._lastEmitTime) / 1000, 0.001);

    // Compute instantaneous sample for this window
    const instantSpeed = this._pendingBytes / elapsedSec;
    this._pendingBytes = 0;
    this._lastEmitTime = now;

    // Stale detection: if no bytes arrived for 3× the interval, reset speed
    const staleSec = (now - this._lastByteTime) / 1000;
    const isStale = staleSec > (this._intervalMs * 3) / 1000;

    if (isStale) {
      this._smoothedSpeed = 0;
    } else if (this._smoothedSpeed === 0) {
      // Cold start: seed EMA with the first real sample to avoid undershoot
      this._smoothedSpeed = instantSpeed;
    } else {
      this._smoothedSpeed =
        EMA_ALPHA * instantSpeed + (1 - EMA_ALPHA) * this._smoothedSpeed;
    }

    // On final emit, fix speed to 0 (download complete, no more bytes)
    if (isFinal) this._smoothedSpeed = 0;

    this._onProgress(this._buildPayload());
  }

  private _buildPayload(): DownloadProgress {
    const total = this._totalBytes;
    const downloaded = this._downloadedBytes;

    const percent =
      total !== null && total > 0
        ? Math.min(100, (downloaded / total) * 100)
        : null;

    const remaining = total !== null ? total - downloaded : null;
    const eta =
      remaining !== null && this._smoothedSpeed > 0
        ? remaining / this._smoothedSpeed
        : null;

    return {
      taskId: this._taskId,
      downloadedBytes: downloaded,
      totalBytes: total,
      percent,
      speedBytesPerSec: Math.round(this._smoothedSpeed),
      etaSeconds: eta !== null ? Math.max(0, eta) : null,
    };
  }
}
