/**
 * @module DownloadMetrics
 *
 * Passive, event-driven metrics collector for DownloadEngine tasks.
 *
 * Design mirrors MetricsEngine in @transferx/core but subscribes to the
 * DownloadEventBus rather than the upload EventBus.
 *
 * The collector is entirely passive — it listens to events the engine
 * emits anyway, adding zero overhead to the download hot path.
 *
 * Usage:
 *   ```typescript
 *   const metrics = new DownloadMetrics();
 *
 *   const task = engine.createTask(url, outputPath);
 *   metrics.attach(task.id, task.bus);  // subscribe before start()
 *
 *   await task.start();
 *
 *   const snap = metrics.getSnapshot(task.id);
 *   console.log(`speed peak: ${snap?.peakSpeedBytesPerSec} B/s`);
 *   console.log(`retry rate: ${(snap?.errorRate ?? 0).toFixed(2)}`);
 *
 *   metrics.detach(task.id, task.bus); // release listeners
 *   ```
 */

import type { DownloadEventBus } from "./EventBus.js";
import type { DownloadEventMap, DownloadEventType } from "./types.js";

// ── Public types ──────────────────────────────────────────────────────────────

export interface DownloadMetricsSnapshot {
  /** Total bytes confirmed written to disk (from progress events). */
  bytesDownloaded: number;
  chunksCompleted: number;
  chunksFailed: number;
  retryCount: number;
  /**
   * chunksFailed / (chunksCompleted + chunksFailed) — in [0, 1].
   * 0 when no chunks have settled yet.
   */
  errorRate: number;
  /**
   * Running mean chunk download latency in ms.
   * Measured from chunkStart to chunkComplete events.
   */
  avgChunkLatencyMs: number;
  /** Highest instantaneous speed seen (from progress events), bytes/sec. */
  peakSpeedBytesPerSec: number;
  /** Most recent smoothed speed from the last progress event, bytes/sec. */
  currentSpeedBytesPerSec: number;
  /** Timestamp (epoch ms) when this snapshot was last updated. */
  capturedAt: number;
}

// ── Internal mutable snapshot ─────────────────────────────────────────────────

interface MutableSnapshot extends DownloadMetricsSnapshot {
  _chunkStartTimes: Map<number, number>;
}

// ── DownloadMetrics ───────────────────────────────────────────────────────────

export class DownloadMetrics {
  private readonly _snapshots = new Map<string, MutableSnapshot>();
  // Per-task handler references needed for detach()
  private readonly _handlers = new Map<
    string,
    Map<DownloadEventType, (...args: unknown[]) => void>
  >();

  /**
   * Start collecting metrics for a task.
   * Call before task.start() to capture all events.
   * Idempotent — calling attach() twice for the same taskId is a no-op.
   */
  attach(taskId: string, bus: DownloadEventBus): void {
    if (this._snapshots.has(taskId)) return;

    const snap: MutableSnapshot = {
      bytesDownloaded: 0,
      chunksCompleted: 0,
      chunksFailed: 0,
      retryCount: 0,
      errorRate: 0,
      avgChunkLatencyMs: 0,
      peakSpeedBytesPerSec: 0,
      currentSpeedBytesPerSec: 0,
      capturedAt: Date.now(),
      _chunkStartTimes: new Map(),
    };
    this._snapshots.set(taskId, snap);

    const taskHandlers = new Map<
      DownloadEventType,
      (...args: unknown[]) => void
    >();

    const onProgress = (p: DownloadEventMap["progress"]) => {
      snap.bytesDownloaded = p.downloadedBytes;
      snap.currentSpeedBytesPerSec = p.speedBytesPerSec;
      if (p.speedBytesPerSec > snap.peakSpeedBytesPerSec) {
        snap.peakSpeedBytesPerSec = p.speedBytesPerSec;
      }
      snap.capturedAt = Date.now();
    };

    const onChunkStart = (e: DownloadEventMap["chunkStart"]) => {
      snap._chunkStartTimes.set(e.chunk.index, Date.now());
    };

    const onChunkComplete = (e: DownloadEventMap["chunkComplete"]) => {
      snap.chunksCompleted++;
      const started = snap._chunkStartTimes.get(e.chunk.index);
      if (started !== undefined) {
        const latencyMs = Date.now() - started;
        // Running mean: newMean = (oldMean × (n-1) + latency) / n
        snap.avgChunkLatencyMs =
          (snap.avgChunkLatencyMs * (snap.chunksCompleted - 1) + latencyMs) /
          snap.chunksCompleted;
        snap._chunkStartTimes.delete(e.chunk.index);
      }
      _updateErrorRate(snap);
      snap.capturedAt = Date.now();
    };

    const onRetry = (_e: DownloadEventMap["retry"]) => {
      snap.retryCount++;
    };

    const onError = (_e: DownloadEventMap["error"]) => {
      snap.chunksFailed++;
      _updateErrorRate(snap);
      snap.capturedAt = Date.now();
    };

    bus.on("progress", onProgress);
    bus.on("chunkStart", onChunkStart);
    bus.on("chunkComplete", onChunkComplete);
    bus.on("retry", onRetry);
    bus.on("error", onError);

    // Store refs for detach()
    taskHandlers.set("progress", onProgress as (...args: unknown[]) => void);
    taskHandlers.set("chunkStart", onChunkStart as (...args: unknown[]) => void);
    taskHandlers.set(
      "chunkComplete",
      onChunkComplete as (...args: unknown[]) => void,
    );
    taskHandlers.set("retry", onRetry as (...args: unknown[]) => void);
    taskHandlers.set("error", onError as (...args: unknown[]) => void);

    this._handlers.set(taskId, taskHandlers);
  }

  /**
   * Stop collecting metrics for a task and remove all event listeners.
   * The accumulated snapshot is kept in memory until reset() is called.
   */
  detach(taskId: string, bus: DownloadEventBus): void {
    const handlers = this._handlers.get(taskId);
    if (!handlers) return;

    for (const [event, handler] of handlers) {
      bus.off(event, handler as Parameters<typeof bus.off>[1]);
    }
    this._handlers.delete(taskId);
  }

  /**
   * Return a read-only snapshot for one task.
   * Returns null when the task was never attached.
   */
  getSnapshot(taskId: string): DownloadMetricsSnapshot | null {
    const snap = this._snapshots.get(taskId);
    if (!snap) return null;
    const { _chunkStartTimes: _ignored, ...rest } = snap;
    return { ...rest };
  }

  /**
   * Return snapshots for all tracked tasks.
   */
  getAllSnapshots(): Map<string, DownloadMetricsSnapshot> {
    const result = new Map<string, DownloadMetricsSnapshot>();
    for (const [id, snap] of this._snapshots) {
      const { _chunkStartTimes: _ignored, ...rest } = snap;
      result.set(id, { ...rest });
    }
    return result;
  }

  /**
   * Aggregate metrics across all tracked tasks.
   */
  getAggregate(): {
    taskCount: number;
    totalBytesDownloaded: number;
    totalChunksCompleted: number;
    totalChunksFailed: number;
    totalRetries: number;
    overallErrorRate: number;
    avgChunkLatencyMs: number;
    peakSpeedBytesPerSec: number;
  } {
    let totalBytes = 0;
    let totalCompleted = 0;
    let totalFailed = 0;
    let totalRetries = 0;
    let latencySum = 0;
    let latencyCount = 0;
    let peakSpeed = 0;

    for (const snap of this._snapshots.values()) {
      totalBytes += snap.bytesDownloaded;
      totalCompleted += snap.chunksCompleted;
      totalFailed += snap.chunksFailed;
      totalRetries += snap.retryCount;
      if (snap.chunksCompleted > 0) {
        latencySum += snap.avgChunkLatencyMs * snap.chunksCompleted;
        latencyCount += snap.chunksCompleted;
      }
      if (snap.peakSpeedBytesPerSec > peakSpeed) {
        peakSpeed = snap.peakSpeedBytesPerSec;
      }
    }

    const total = totalCompleted + totalFailed;
    return {
      taskCount: this._snapshots.size,
      totalBytesDownloaded: totalBytes,
      totalChunksCompleted: totalCompleted,
      totalChunksFailed: totalFailed,
      totalRetries,
      overallErrorRate: total > 0 ? totalFailed / total : 0,
      avgChunkLatencyMs: latencyCount > 0 ? latencySum / latencyCount : 0,
      peakSpeedBytesPerSec: peakSpeed,
    };
  }

  /**
   * Clear snapshots.
   * @param taskId  Clear one task. Omit to clear all.
   */
  reset(taskId?: string): void {
    if (taskId !== undefined) {
      this._snapshots.delete(taskId);
    } else {
      this._snapshots.clear();
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _updateErrorRate(snap: MutableSnapshot): void {
  const total = snap.chunksCompleted + snap.chunksFailed;
  snap.errorRate = total > 0 ? snap.chunksFailed / total : 0;
}
