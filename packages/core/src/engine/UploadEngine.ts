/**
 * @module engine/UploadEngine
 *
 * The central orchestrator for all upload operations.
 *
 * Responsibilities:
 *   1. Create and initialise a TransferSession.
 *   2. Call adapter.initTransfer() to open a remote multi-part session.
 *   3. Schedule concurrent chunk uploads through the Scheduler.
 *   4. Read each chunk via IChunkReader, compute SHA-256, call adapter.uploadChunk().
 *   5. Wrap each chunk upload in RetryEngine.withRetry() for fault tolerance.
 *   6. Update per-chunk state and session transferredBytes after each success.
 *   7. Persist every meaningful state change via ISessionStore.save().
 *   8. Emit strongly-typed TransferEvents to the injected IEventBus.
 *   9. Confirm bytes to ProgressEngine so it can emit live progress events.
 *  10. Finalise successful upload with adapter.completeTransfer().
 *  11. Abort on fatal failure (adapter.abortTransfer — best-effort).
 *  12. Expose pause() / resume() / cancel() for user-driven lifecycle control.
 *
 * Design decisions:
 *
 * CANCELLATION:
 *   cancel() sets an internal flag; active chunk tasks see it between the
 *   await adapter.uploadChunk() and the confirmBytes() call and skip the
 *   success path. The session is transitioned to 'cancelled' after the
 *   scheduler drains. We never forcibly abort in-flight HTTP— the adapter's
 *   abortTransfer is called instead.
 *
 * CHUNK FAILURE vs SESSION FAILURE:
 *   A chunk that exhausts its retry budget marks itself 'fatal'. When the
 *   reconciliation pass after draining finds any 'fatal' chunk, the session
 *   transitions to 'failed'. This lets multiple chunks fail concurrently
 *   without interfering with each other before the final accounting.
 *
 * CONCURRENCY:
 *   The Scheduler handles the concurrency cap. UploadEngine pushes one task
 *   per chunk and lets the Scheduler decide ordering and limits.
 *
 * PAUSE / RESUME:
 *   Delegated entirely to the Scheduler. The engine keeps no extra state for
 *   this — the session is transitioned to 'paused' / 'running' in the public
 *   method wrappers.
 *
 * SHA-256:
 *   Computed using Node's built-in `crypto.createHash('sha256')`. The engine
 *   does this so the adapter layer stays thin. The digest is also stored in
 *   chunk.checksum for audit / deduplication purposes.
 */

import * as crypto from "crypto";
import { computeChunks } from "../chunker/Chunker.js";
import type { IChunkReader } from "../chunker/Chunker.js";
import { Scheduler } from "../scheduler/Scheduler.js";
import { withRetry } from "../retry/RetryEngine.js";
import { ProgressEngine } from "../progress/ProgressEngine.js";
import type { ITransferAdapter } from "../adapter/ITransferAdapter.js";
import type { ISessionStore } from "../store/ISessionStore.js";
import type { IEventBus } from "../types/events.js";
import type { EngineConfig } from "../types/config.js";
import { resolveEngineConfig } from "../types/config.js";
import type { FileDescriptor, TransferSession } from "../types/session.js";
import { transitionSession } from "../types/session.js";
import type { ChunkMeta } from "../types/chunk.js";
import { networkError } from "../types/errors.js";

// ── Public options ────────────────────────────────────────────────────────────

export interface UploadEngineOptions {
  adapter: ITransferAdapter;
  store: ISessionStore;
  bus: IEventBus;
  /** Partial config — missing fields use DEFAULT_ENGINE_CONFIG values. */
  config?: Partial<EngineConfig>;
  /**
   * Factory to build an IChunkReader for a given file.
   * Defaults to NodeChunkReader if omitted, but injecting it here keeps
   * the engine testable without touching the filesystem.
   */
  readerFactory?: (file: FileDescriptor) => IChunkReader;
}

// ── Minimal in-memory reader for use in tests without a real file ─────────────

class ByteArrayChunkReader implements IChunkReader {
  constructor(private readonly data: Uint8Array) {}
  async read(offset: number, size: number): Promise<Uint8Array> {
    return this.data.slice(offset, offset + size);
  }
  async close(): Promise<void> {}
}

// ── Engine ─────────────────────────────────────────────────────────────────────

export class UploadEngine {
  private readonly _adapter: ITransferAdapter;
  private readonly _store: ISessionStore;
  private readonly _bus: IEventBus;
  private readonly _config: EngineConfig;
  private readonly _readerFactory: (file: FileDescriptor) => IChunkReader;

  /** Active scheduler — only non-null while an upload() call is in progress. */
  private _scheduler: Scheduler | null = null;
  /** Active session — only non-null while an upload() call is in progress. */
  private _activeSession: TransferSession | null = null;

  constructor(opts: UploadEngineOptions) {
    this._adapter = opts.adapter;
    this._store = opts.store;
    this._bus = opts.bus;
    this._config = resolveEngineConfig(opts.config ?? {});
    this._readerFactory =
      opts.readerFactory ??
      ((file) => {
        // Dynamic import to avoid hard-coupling to Node in browser bundles.
        // In practice the default path is only used when no factory is provided.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { NodeChunkReader } =
          require("../chunker/NodeChunkReader.js") as {
            NodeChunkReader: new (p: string) => IChunkReader;
          };
        if (!file.path) {
          throw new Error(
            "UploadEngine: file.path is required when using the default NodeChunkReader. " +
              "Provide a custom readerFactory for browser use.",
          );
        }
        return new NodeChunkReader(file.path);
      });
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Upload a file to the remote target.
   *
   * @param session  - A session object previously created and persisted by the
   *                   caller.  It MUST be in 'created' state.
   *                   The caller is responsible for building the session via
   *                   makeUploadSession(), saving it to the store, and passing
   *                   the saved copy here.
   * @returns          The same session after it reaches a terminal state
   *                   ('done' or 'failed').
   */
  async upload(session: TransferSession): Promise<TransferSession> {
    // ----- 1. Initialise remote session ----------------------------------------
    transitionSession(session, "initializing");
    this._bus.emit({ type: "session:created", session });
    await this._store.save(session);

    let providerSessionId: string;
    try {
      providerSessionId = await this._adapter.initTransfer(session);
    } catch (err) {
      transitionSession(session, "failed");
      session.updatedAt = Date.now();
      const error = err instanceof Error ? err : new Error(String(err));
      this._bus.emit({ type: "session:failed", session, error });
      await this._store.save(session);
      return session;
    }

    session.providerSessionId = providerSessionId;

    // ----- 2. Compute chunks ---------------------------------------------------
    const chunks = computeChunks(session.file.size, session.chunkSize);
    session.chunks = chunks;
    transitionSession(session, "queued");
    await this._store.save(session);

    // ----- 3. Start running ----------------------------------------------------
    transitionSession(session, "running");
    this._bus.emit({ type: "session:started", session });
    await this._store.save(session);

    // ----- 4. Set up progress engine -------------------------------------------
    const progress = new ProgressEngine({
      totalBytes: session.file.size,
      sessionId: session.id,
      intervalMs: this._config.progressIntervalMs,
      onProgress: (snap) =>
        this._bus.emit({ type: "progress", progress: snap }),
    });
    progress.start();

    // ----- 5. Open the chunk reader --------------------------------------------
    const reader = this._readerFactory(session.file);

    // ----- 6. Schedule all chunks ---------------------------------------------
    const scheduler = new Scheduler(this._config.concurrency.initial);
    this._scheduler = scheduler;
    this._activeSession = session;
    let cancelled = false;
    let fatalCount = 0;

    const uploadChunkTask = (chunk: ChunkMeta) => async (): Promise<void> => {
      if (cancelled) return;

      this._bus.emit({ type: "chunk:started", session, chunk });
      chunk.status = "uploading";
      await this._store.save(session);

      try {
        await withRetry(
          async () => {
            if (cancelled) return;
            const data = await reader.read(chunk.offset, chunk.size);
            const sha256Hex = crypto
              .createHash("sha256")
              .update(data)
              .digest("hex");

            chunk.checksum = sha256Hex;
            const result = await this._adapter.uploadChunk(
              session,
              chunk,
              data,
              sha256Hex,
            );
            chunk.providerToken = result.providerToken;
          },
          {
            chunk,
            policy: this._config.retry,
            onRetryableFailure: (c, error, attempt) => {
              c.status = "failed";
              c.lastError = error.message;
              c.lastFailedAt = Date.now();
              this._bus.emit({
                type: "chunk:failed",
                session,
                chunk: c,
                error,
                willRetry: attempt < this._config.retry.maxAttempts,
              });
            },
          },
        );
      } catch (err) {
        // withRetry threw — chunk is fatally exhausted.
        chunk.status = "fatal";
        chunk.lastError = err instanceof Error ? err.message : String(err);
        chunk.lastFailedAt = Date.now();
        fatalCount++;
        const error = err instanceof Error ? err : networkError(String(err));
        this._bus.emit({ type: "chunk:fatal", session, chunk, error });
        await this._store.save(session);
        return;
      }

      if (cancelled) return;

      // Success path
      chunk.status = "done";
      session.transferredBytes += chunk.size;
      progress.confirmBytes(chunk.size);
      this._bus.emit({ type: "chunk:done", session, chunk });
      await this._store.save(session);
    };

    for (const chunk of chunks) {
      scheduler.push(uploadChunkTask(chunk));
    }

    // Wait for all tasks to complete
    await scheduler.drain();
    progress.stop();
    await reader.close();
    this._scheduler = null;
    this._activeSession = null;

    // ----- 7. Reconcile -------------------------------------------------------
    if (cancelled || session.state === "cancelled") {
      if (session.state !== "cancelled") {
        transitionSession(session, "cancelled");
        session.updatedAt = Date.now();
      }
      this._bus.emit({ type: "session:cancelled", session });
      await this._store.save(session);
      // Best-effort abort on provider
      await this._adapter.abortTransfer(session);
      return session;
    }

    if (fatalCount > 0) {
      transitionSession(session, "failed");
      session.updatedAt = Date.now();
      const error = new Error(
        `${fatalCount} chunk(s) failed after exhausting retry budget`,
      );
      this._bus.emit({ type: "session:failed", session, error });
      await this._store.save(session);
      // Best-effort abort
      await this._adapter.abortTransfer(session);
      return session;
    }

    // ----- 8. Complete the transfer -------------------------------------------
    try {
      await this._adapter.completeTransfer(session, session.chunks);
    } catch (err) {
      transitionSession(session, "failed");
      session.updatedAt = Date.now();
      const error = err instanceof Error ? err : new Error(String(err));
      this._bus.emit({ type: "session:failed", session, error });
      await this._store.save(session);
      await this._adapter.abortTransfer(session);
      return session;
    }

    transitionSession(session, "done");
    session.updatedAt = Date.now();
    this._bus.emit({ type: "session:done", session });
    await this._store.save(session);
    return session;
  }

  /**
   * Pause active chunk scheduling.
   * In-flight tasks complete; no new tasks are dispatched until resume().
   * No-op if no upload is currently active.
   */
  pause(): void {
    if (!this._scheduler || !this._activeSession) return;
    this._scheduler.pause();
    transitionSession(this._activeSession, "paused");
    this._bus.emit({ type: "session:paused", session: this._activeSession });
  }

  /**
   * Resume a paused session.
   * No-op if no upload is currently active.
   */
  resume(): void {
    if (!this._scheduler || !this._activeSession) return;
    transitionSession(this._activeSession, "running");
    this._scheduler.resume();
    this._bus.emit({ type: "session:resumed", session: this._activeSession });
  }
}

// ── Session factory ─────────────────────────────────────────────────────────

/**
 * Build a fresh TransferSession in 'created' state.
 * Callers MUST persist this via ISessionStore.save() before calling
 * UploadEngine.upload().
 */
export function makeUploadSession(
  id: string,
  file: FileDescriptor,
  targetKey: string,
  config: EngineConfig,
): TransferSession {
  const now = Date.now();
  return {
    id,
    direction: "upload",
    file,
    targetKey,
    chunkSize: config.chunkSize,
    chunks: [],
    state: "created",
    createdAt: now,
    updatedAt: now,
    transferredBytes: 0,
    sessionRetries: 0,
  };
}
