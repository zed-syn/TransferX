/**
 * @module types/index
 * Re-exports all public types from the types sub-package.
 */

export type { ChunkMeta, ChunkStatus } from "./chunk.js";
export { makeChunkMeta } from "./chunk.js";

export type {
  TransferSession,
  SessionState,
  TransferDirection,
  FileDescriptor,
} from "./session.js";
export {
  transitionSession,
  getTransferredBytes,
  getProgressPercent,
  hasFatalChunks,
  allChunksDone,
  TERMINAL_STATES,
  RESUMABLE_STATES,
} from "./session.js";

export type { RetryPolicy, ConcurrencyPolicy, EngineConfig } from "./config.js";
export {
  DEFAULT_RETRY_POLICY,
  DEFAULT_CONCURRENCY_POLICY,
  DEFAULT_ENGINE_CONFIG,
  resolveEngineConfig,
} from "./config.js";

export type {
  TransferProgress,
  TransferEvent,
  LogLevel,
  EventHandler,
  IEventBus,
} from "./events.js";

export type { ErrorCategory } from "./errors.js";
export {
  TransferError,
  RETRYABLE_CATEGORIES,
  networkError,
  rateLimitError,
  serverError,
  clientError,
  authError,
  checksumError,
  cancelledError,
} from "./errors.js";
