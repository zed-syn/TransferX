/**
 * @module @transferx/core
 * Public API surface for the TransferX core package.
 */

// Types
export type { ChunkMeta, ChunkStatus } from "./types/chunk.js";
export { makeChunkMeta } from "./types/chunk.js";

export type {
  TransferSession,
  SessionState,
  TransferDirection,
  FileDescriptor,
} from "./types/session.js";
export {
  transitionSession,
  getTransferredBytes,
  getProgressPercent,
  hasFatalChunks,
  allChunksDone,
  TERMINAL_STATES,
  RESUMABLE_STATES,
} from "./types/session.js";

export type {
  RetryPolicy,
  ConcurrencyPolicy,
  EngineConfig,
} from "./types/config.js";
export { resolveEngineConfig } from "./types/config.js";

export type {
  TransferEvent,
  TransferProgress,
  IEventBus,
  LogLevel,
} from "./types/events.js";

export { TransferError } from "./types/errors.js";
export type { ErrorCategory } from "./types/errors.js";
export {
  networkError,
  rateLimitError,
  serverError,
  clientError,
  authError,
  checksumError,
  cancelledError,
  invalidStateError,
  sessionNotFoundError,
  fileChangedError,
  zeroByteError,
  concurrentUploadError,
  duplicateUploadError,
} from "./types/errors.js";

// Chunker
export {
  computeChunks,
  validateChunks,
  recommendChunkSize,
} from "./chunker/Chunker.js";
export type { IChunkReader } from "./chunker/Chunker.js";
export { NodeChunkReader } from "./chunker/NodeChunkReader.js";

// Scheduler
export { Scheduler } from "./scheduler/Scheduler.js";
export type { SchedulerStats } from "./scheduler/Scheduler.js";

// Retry
export { withRetry, computeBackoff } from "./retry/RetryEngine.js";
export type { RetryContext } from "./retry/RetryEngine.js";

// Progress
export { ProgressEngine } from "./progress/ProgressEngine.js";
export type { ProgressEngineOptions } from "./progress/ProgressEngine.js";

// Stores
export type { ISessionStore } from "./store/ISessionStore.js";
export { MemorySessionStore } from "./store/MemorySessionStore.js";
export { FileSessionStore } from "./store/FileSessionStore.js";

// Adapter interface
export type {
  ITransferAdapter,
  ChunkUploadResult,
  RemoteUploadState,
} from "./adapter/ITransferAdapter.js";

// EventBus
export { EventBus } from "./events/EventBus.js";

// Engine
export {
  UploadEngine,
  makeUploadSession,
  makeSessionId,
} from "./engine/UploadEngine.js";
export type { UploadEngineOptions } from "./engine/UploadEngine.js";

// Transfer Manager
export { TransferManager } from "./manager/TransferManager.js";
export type {
  TransferManagerOptions,
  TransferManagerStatus,
} from "./manager/TransferManager.js";

// Metrics
export { MetricsEngine } from "./metrics/MetricsEngine.js";
export type { MetricsSnapshot } from "./metrics/MetricsEngine.js";
