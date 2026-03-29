/**
 * @module @transferx/downloader
 *
 * IDM-class parallel download engine for Node.js / Electron.
 *
 * Features:
 *   - Multi-connection HTTP range download with configurable concurrency
 *   - Streaming writes at exact byte offsets (pwrite semantics — no corruption)
 *   - Byte-level resume after process crash or restart
 *   - Per-chunk retry with exponential back-off + full jitter
 *   - EMA-smoothed speed and ETA reporting
 *   - Adaptive concurrency tuning based on live error-rate signal
 *   - Graceful fallback to single-stream when server lacks range support
 *   - Fully typed event bus for start/progress/pause/resume/cancel/complete
 *
 * Quick start:
 *
 *   ```typescript
 *   import { DownloadEngine } from '@transferx/downloader';
 *
 *   const engine = new DownloadEngine({ concurrency: { initial: 8 } });
 *   const task = engine.createTask('https://example.com/file.zip', '/tmp/file.zip');
 *
 *   task.on('progress', p => console.log(`${p.percent?.toFixed(1)}%  ${p.speedBytesPerSec} B/s`));
 *   await task.start();
 *   ```
 *
 * Resume after crash:
 *
 *   ```typescript
 *   const engine = new DownloadEngine({
 *     storeDir: './.transferx-downloads',
 *   });
 *   // Sessions are automatically persisted. On next start, call:
 *   const task = await engine.resumeTask(sessionId);
 *   await task.start();
 *   ```
 */

// ── Types & interfaces ────────────────────────────────────────────────────────
export type {
  ChunkMeta,
  ChunkStatus,
  DownloadConfig,
  DownloadError,
  DownloadEventHandler,
  DownloadEventMap,
  DownloadEventType,
  DownloadProgress,
  DownloadSession,
  DownloadStatus,
  ErrorCategory,
  ConcurrencyPolicy,
  RetryPolicy,
  ServerCapability,
} from "./types.js";

export {
  resolveDownloadConfig,
  networkError,
  timeoutError,
  diskError,
  staleError,
  httpError,
} from "./types.js";

// ── Infrastructure components ─────────────────────────────────────────────────
export { DownloadEventBus } from "./EventBus.js";
export { CapabilityDetector } from "./CapabilityDetector.js";
export { RangePlanner } from "./RangePlanner.js";
export { FileWriter } from "./FileWriter.js";
export { ResumeStore } from "./ResumeStore.js";
export { BufferPool } from "./BufferPool.js";

// ── Execution layer ───────────────────────────────────────────────────────
export { withRetry } from "./RetryEngine.js";
export { ProgressEngine } from "./ProgressEngine.js";
export { ChunkScheduler } from "./ChunkScheduler.js";
export { DownloadEngine } from "./DownloadEngine.js";
export type { DownloadResult, DownloadEngineTask } from "./DownloadEngine.js";
export { DownloadTask, createDownloadTask } from "./DownloadTask.js";

// ── Global coordinator (Phase 3) ───────────────────────────────────────────
export { DownloadManager } from "./DownloadManager.js";
export type {
  DownloadManagerOptions,
  DownloadManagerStatus,
  ManagedDownload,
} from "./DownloadManager.js";

// ── Observability (Phase 4) ───────────────────────────────────────────────
export { DownloadMetrics } from "./DownloadMetrics.js";
export type { DownloadMetricsSnapshot } from "./DownloadMetrics.js";
