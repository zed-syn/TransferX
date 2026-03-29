/**
 * @module types/events
 *
 * Strongly-typed event system for the SDK.
 * All public events emitted by the engine / tasks are defined here.
 * We use a discriminated union so consumers get full type narrowing.
 */

import type { TransferSession } from "./session.js";
import type { ChunkMeta } from "./chunk.js";

// ── Per-transfer progress snapshot ──────────────────────────────────────────

export interface TransferProgress {
  /** Session ID this progress belongs to. */
  sessionId: string;
  /** 0–100 (never exceeds 100). */
  percent: number;
  /** Bytes confirmed by the remote end so far (done chunks only). */
  transferredBytes: number;
  /** Total bytes of the transfer. */
  totalBytes: number;
  /** Instantaneous smoothed throughput in bytes/s. */
  speedBytesPerSec: number;
  /**
   * Estimated seconds remaining.
   * Undefined when speed is 0 or unknown.
   */
  etaSeconds: number | undefined;
}

// ── Event discriminated union ────────────────────────────────────────────────

export type TransferEvent =
  | { type: "session:created"; session: TransferSession }
  | { type: "session:started"; session: TransferSession }
  | { type: "session:paused"; session: TransferSession }
  | { type: "session:resumed"; session: TransferSession }
  | { type: "session:reconciling"; session: TransferSession }
  | { type: "session:done"; session: TransferSession }
  | { type: "session:failed"; session: TransferSession; error: Error }
  | { type: "session:cancelled"; session: TransferSession }
  | { type: "chunk:started"; session: TransferSession; chunk: ChunkMeta }
  | { type: "chunk:done"; session: TransferSession; chunk: ChunkMeta }
  | {
      type: "chunk:failed";
      session: TransferSession;
      chunk: ChunkMeta;
      error: Error;
      willRetry: boolean;
    }
  | {
      type: "chunk:fatal";
      session: TransferSession;
      chunk: ChunkMeta;
      error: Error;
    }
  | { type: "progress"; progress: TransferProgress }
  | {
      type: "log";
      level: LogLevel;
      message: string;
      context?: Record<string, unknown>;
    };

export type LogLevel = "debug" | "info" | "warn" | "error";

// ── Typed event emitter contract ─────────────────────────────────────────────

export type EventHandler<E extends TransferEvent = TransferEvent> = (
  event: E,
) => void;

/**
 * Minimal typed event emitter interface.
 * Not a full Node EventEmitter — keeps the public API minimal & portable.
 */
export interface IEventBus {
  on<T extends TransferEvent["type"]>(
    type: T,
    handler: EventHandler<Extract<TransferEvent, { type: T }>>,
  ): () => void; // returns unsubscribe function

  emit(event: TransferEvent): void;

  off<T extends TransferEvent["type"]>(
    type: T,
    handler: EventHandler<Extract<TransferEvent, { type: T }>>,
  ): void;
}
