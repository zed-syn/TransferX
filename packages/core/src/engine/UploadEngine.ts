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
 *  12. Expose pause(sessionId) / resume(sessionId) / cancel(sessionId) for lifecycle control.
 *
 * Design decisions:
 *
 * CANCELLATION:
 *   cancel(sessionId) sets a per-session flag in _cancelFlags. Active chunk
 *   tasks check this flag and skip the success path. The session transitions to
 *   'cancelled' after the scheduler drains, then adapter.abortTransfer() is called.
 *
 * RESUME:
 *   resume(sessionId) loads the persisted session, runs reconciliation
 *   (optionally querying the provider for already-uploaded parts), resets
 *   non-done chunks to 'pending', and re-runs _runChunks with only those chunks.
 *
 * RECONCILIATION:
 *   If the adapter implements getRemoteState(), the engine compares remote
 *   uploaded parts against local chunk state. Chunks the provider already has
 *   are marked done (or kept done); chunks the local store thinks are done but
 *   the provider doesn't have are reset to pending.
 *
 * ZERO-BYTE FILES:
 *   Rejected immediately — multipart upload providers require at least one part.
 *
 * CONCURRENT UPLOAD GUARD:
 *   The _activeUploads Set prevents the same sessionId from being uploaded
 *   concurrently within the same engine instance.
 *
 * SHA-256:
 *   Computed using Node's built-in `crypto.createHash('sha256')`. The engine
 *   does this so the adapter layer stays thin. The digest is also stored in
 *   chunk.checksum for audit / deduplication purposes.
 */

import * as crypto from "crypto";
import { createRequire } from "module";
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
import { transitionSession, getTransferredBytes } from "../types/session.js";
import type { ChunkMeta } from "../types/chunk.js";
import {
  networkError,
  zeroByteError,
  concurrentUploadError,
  sessionNotFoundError,
  invalidStateError,
  fileChangedError,
} from "../types/errors.js";

// Module-level require function — works in both CJS (compiled output) and
// forward-compatible with ESM. Using createRequire avoids the implicit CJS
// `require` global that is not available in pure-ESM contexts.
const _require = createRequire(__filename);

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
  /**
   * Optional function to stat a file by path.
   * When provided, `resumeSession()` calls this for Node uploads and compares
   * the returned `mtimeMs` against the value stored in `session.file.mtimeMs`.
   * If they differ the session is aborted with a `fileChangedError`.
   *
   * Example (Node.js):
   * ```ts
   * import { stat } from 'fs/promises';
   * fileStatFn: (path) => stat(path)
   * ```
   */
  fileStatFn?: (path: string) => Promise<{ mtimeMs: number }>;
}

// ── Minimal in-memory reader for use in tests without a real file ─────────────

class ByteArrayChunkReader implements IChunkReader {
  constructor(private readonly data: Uint8Array) {}
  async read(offset: number, size: number): Promise<Uint8Array> {
    return this.data.slice(offset, offset + size);
  }
  async close(): Promise<void> {}
}

// ── Internal running-session handle ──────────────────────────────────────────

interface ActiveUpload {
  scheduler: Scheduler;
  session: TransferSession;
}

// ── Engine ─────────────────────────────────────────────────────────────────────

export class UploadEngine {
  private readonly _adapter: ITransferAdapter;
  private readonly _store: ISessionStore;
  private readonly _bus: IEventBus;
  private readonly _config: EngineConfig;
  private readonly _readerFactory: (file: FileDescriptor) => IChunkReader;
  private readonly _fileStatFn:
    | ((path: string) => Promise<{ mtimeMs: number }>)
    | undefined;

  /** sessionId → active upload handle. Prevents concurrent uploads of same session. */
  private readonly _activeUploads = new Map<string, ActiveUpload>();
  /** sessionId → true when cancel() has been called for an in-flight upload. */
  private readonly _cancelFlags = new Set<string>();

  constructor(opts: UploadEngineOptions) {
    this._adapter = opts.adapter;
    this._store = opts.store;
    this._bus = opts.bus;
    this._config = resolveEngineConfig(opts.config ?? {});
    this._fileStatFn = opts.fileStatFn;
    this._readerFactory =
      opts.readerFactory ??
      ((file) => {
        // Lazy-load NodeChunkReader to avoid hard-coupling to Node in browser
        // bundles. Using createRequire (module-level) ensures compatibility with
        // both CJS output and future ESM callers.
        const { NodeChunkReader } = _require(
          "../chunker/NodeChunkReader.js",
        ) as {
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
   * Upload a file from scratch.
   * The session MUST be in 'created' state and already persisted to the store.
   * Throws synchronously for zero-byte files or concurrent sessions.
   */
  async upload(session: TransferSession): Promise<TransferSession> {
    // Guard: zero-byte files cannot use multipart
    if (session.file.size === 0) {
      throw zeroByteError();
    }

    // Guard: prevent concurrent uploads of the same session
    if (this._activeUploads.has(session.id)) {
      throw concurrentUploadError(session.id);
    }

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

    // ----- 3. Run chunks -------------------------------------------------------
    return this._runChunks(session, chunks);
  }

  /**
   * Resume a session that was previously paused, failed, or whose process
   * crashed mid-upload.
   *
   * Flow:
   *   1. Load session from store.
   *   2. Validate it can be resumed (not done/cancelled).
   *   3. Reconcile local vs remote state.
   *   4. Re-upload only pending/failed chunks.
   *
   * @throws {TransferError} with category 'sessionNotFound' if not in store.
   * @throws {TransferError} with category 'invalidState' if session is done/cancelled.
   * @throws {TransferError} with category 'concurrentUpload' if already active.
   */
  async resumeSession(sessionId: string): Promise<TransferSession> {
    // ----- 1. Load -------------------------------------------------------
    const session = await this._store.load(sessionId);
    if (!session) {
      throw sessionNotFoundError(sessionId);
    }

    // ----- 2. Validate state ─────────────────────────────────────────────
    if (session.state === "done" || session.state === "cancelled") {
      throw invalidStateError(sessionId, session.state, "resume");
    }

    if (this._activeUploads.has(sessionId)) {
      throw concurrentUploadError(sessionId);
    }

    // ----- 2b. File-change detection (Node.js) ───────────────────────────
    // If a stat function was injected and the session recorded the file's
    // mtime at creation time, verify the file hasn't changed since then.
    if (
      this._fileStatFn &&
      session.file.path &&
      session.file.mtimeMs !== undefined
    ) {
      const current = await this._fileStatFn(session.file.path);
      if (current.mtimeMs !== session.file.mtimeMs) {
        throw fileChangedError(sessionId);
      }
    }

    // ----- 3. Reconcile remote state ─────────────────────────────────────
    transitionSession(session, "reconciling");
    this._bus.emit({ type: "session:reconciling", session });
    await this._store.save(session);

    try {
      await this._reconcile(session);
    } catch (err) {
      transitionSession(session, "failed");
      session.updatedAt = Date.now();
      const error = err instanceof Error ? err : new Error(String(err));
      this._bus.emit({ type: "session:failed", session, error });
      await this._store.save(session);
      return session;
    }

    // ----- 4. Recompute transferredBytes from source-of-truth ────────────
    session.transferredBytes = getTransferredBytes(session);

    // ----- 5. Identify chunks still to upload ────────────────────────────
    const pendingChunks = session.chunks.filter(
      (c) =>
        c.status === "pending" ||
        c.status === "failed" ||
        c.status === "uploading",
    );

    // Reset any 'uploading' chunks (the previous process died mid-flight)
    for (const c of pendingChunks) {
      if (c.status === "uploading") c.status = "pending";
    }

    this._bus.emit({
      type: "log",
      level: "info",
      message: `[TransferX] Reconcile complete for session ${sessionId}: ${pendingChunks.length} chunk(s) pending, ${session.chunks.length - pendingChunks.length} already done`,
      context: {
        sessionId,
        pending: pendingChunks.length,
        done: session.chunks.length - pendingChunks.length,
      },
    });

    if (pendingChunks.length === 0) {
      // All chunks already done locally — go straight to complete
      return this._complete(session);
    }

    // ----- 6. Re-run the scheduler for pending chunks ────────────────────
    return this._runChunks(session, pendingChunks);
  }

  /**
   * Pause an active upload.
   * In-flight chunk tasks finish; no new tasks are dispatched until resumeSession().
   * No-op if the session is not currently active in this engine.
   */
  pause(sessionId: string): void {
    const active = this._activeUploads.get(sessionId);
    if (!active) return;
    active.scheduler.pause();
    try {
      transitionSession(active.session, "paused");
    } catch {
      // Already in a state that can't transition — safe to ignore
    }
    this._bus.emit({ type: "session:paused", session: active.session });
  }

  /**
   * Resume a scheduler that was paused via pause().
   * This resumes in-process scheduling — for crash recovery use resumeSession().
   */
  resumeScheduler(sessionId: string): void {
    const active = this._activeUploads.get(sessionId);
    if (!active) return;
    try {
      transitionSession(active.session, "running");
    } catch {
      // Already running — no-op
    }
    active.scheduler.resume();
    this._bus.emit({ type: "session:resumed", session: active.session });
  }

  /**
   * Cancel an active or persisted session.
   *
   * If the session is in-flight in this engine, the upload stops after the
   * current in-flight chunks finish. If the session is only persisted, it is
   * loaded, transitioned to cancelled, and the adapter is asked to abort.
   */
  async cancel(sessionId: string): Promise<void> {
    const active = this._activeUploads.get(sessionId);
    if (active) {
      // Signal the running upload to stop
      this._cancelFlags.add(sessionId);
      active.scheduler.pause();
      active.scheduler.clear(); // Drop queued-but-not-started tasks so drain() resolves
      return; // The upload() / resumeSession() call handles cleanup after drain
    }

    // Not currently active — load + cancel from store
    const session = await this._store.load(sessionId);
    if (!session) return; // Nothing to cancel
    if (session.state === "done" || session.state === "cancelled") return;

    try {
      transitionSession(session, "cancelled");
    } catch {
      return; // Couldn't transition — ignore
    }
    session.updatedAt = Date.now();
    this._bus.emit({ type: "session:cancelled", session });
    await this._store.save(session);
    // Best-effort remote abort
    await this._adapter.abortTransfer(session).catch(() => undefined);
  }

  /**
   * Return the current persisted state of a session.
   * Returns null if not found in the store.
   */
  async getSession(sessionId: string): Promise<TransferSession | null> {
    return (await this._store.load(sessionId)) ?? null;
  }

  // ── Private implementation ────────────────────────────────────────────────

  /**
   * Reconcile local chunk states against what the provider actually has.
   * Mutates chunk.status in-place.
   */
  private async _reconcile(session: TransferSession): Promise<void> {
    if (!this._adapter.getRemoteState || !session.providerSessionId) {
      // No remote state available — trust local state.
      // Reset any 'uploading' chunks (orphaned from the previous run).
      for (const c of session.chunks) {
        if (c.status === "uploading") c.status = "pending";
        if (c.status === "fatal") c.status = "pending"; // allow retry on resume
      }
      return;
    }

    let remoteState: Awaited<
      ReturnType<ITransferAdapter["getRemoteState"] & {}>
    >;
    try {
      remoteState = await this._adapter.getRemoteState(session);
    } catch {
      // Provider query failed — fall back to local state only
      for (const c of session.chunks) {
        if (c.status === "uploading") c.status = "pending";
        if (c.status === "fatal") c.status = "pending";
      }
      return;
    }

    const remoteByPart = new Map(
      remoteState.uploadedParts.map((p) => [p.partNumber, p.providerToken]),
    );

    for (const chunk of session.chunks) {
      const remoteToken = remoteByPart.get(chunk.index + 1); // parts are 1-based
      if (remoteToken !== undefined) {
        // Provider has it — mark done and set/confirm providerToken
        chunk.status = "done";
        chunk.providerToken = remoteToken;
      } else {
        // Provider doesn't have it — reset to pending
        if (chunk.status !== "done") {
          chunk.status = "pending";
        } else {
          // Local says done but remote doesn't → reset
          chunk.status = "pending";
          delete (chunk as { providerToken?: string }).providerToken;
        }
      }
    }
  }

  /**
   * Schedule and execute uploads for the given chunk list.
   * Handles the entire running → done/failed/cancelled lifecycle.
   */
  private async _runChunks(
    session: TransferSession,
    chunks: ChunkMeta[],
  ): Promise<TransferSession> {
    // Transition to running
    transitionSession(session, "running");
    this._bus.emit({ type: "session:started", session });
    await this._store.save(session);

    const alreadyTransferred = getTransferredBytes(session);

    // Progress engine starts from already-transferred bytes
    const progress = new ProgressEngine({
      totalBytes: session.file.size,
      sessionId: session.id,
      intervalMs: this._config.progressIntervalMs,
      onProgress: (snap) =>
        this._bus.emit({ type: "progress", progress: snap }),
    });
    // Pre-confirm already done bytes so the progress bar doesn't reset
    progress.start();
    if (alreadyTransferred > 0) {
      progress.confirmBytes(alreadyTransferred);
    }

    const reader = this._readerFactory(session.file);
    const scheduler = new Scheduler(this._config.concurrency);

    this._activeUploads.set(session.id, { scheduler, session });
    let fatalCount = 0;

    const isCancelled = () => this._cancelFlags.has(session.id);

    const uploadChunkTask = (chunk: ChunkMeta) => async (): Promise<void> => {
      if (isCancelled()) return;

      this._bus.emit({ type: "chunk:started", session, chunk });
      chunk.status = "uploading";
      await this._store.save(session);

      try {
        await withRetry(
          async () => {
            if (isCancelled()) return;
            const data = await reader.read(chunk.offset, chunk.size);

            // Compute SHA-256 only when integrity verification is enabled.
            // Skip the CPU cost when the caller opts out (checksumVerify: false).
            const sha256Hex = this._config.checksumVerify
              ? crypto.createHash("sha256").update(data).digest("hex")
              : "";
            if (sha256Hex) chunk.checksum = sha256Hex;

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
              c.retries++;
              c.lastError = error.message;
              c.lastFailedAt = Date.now();
              // Signal adaptive concurrency on every retryable failure, not just the final
              // fatal one. Without this the adaptive algorithm sees ~1/maxAttempts of the
              // real error rate and reacts 5× too slowly under network degradation.
              scheduler.recordFailure();
              this._bus.emit({
                type: "chunk:failed",
                session,
                chunk: c,
                error,
                willRetry: attempt < this._config.retry.maxAttempts,
              });
              this._bus.emit({
                type: "log",
                level: "warn",
                message: `[TransferX] chunk ${c.index} attempt ${attempt} failed (${error.category}): ${error.message}`,
                context: {
                  sessionId: session.id,
                  chunkIndex: c.index,
                  attempt,
                  category: error.category,
                },
              });
            },
          },
        );
      } catch (err) {
        chunk.status = "fatal";
        chunk.lastError = err instanceof Error ? err.message : String(err);
        chunk.lastFailedAt = Date.now();
        fatalCount++;
        const error = err instanceof Error ? err : networkError(String(err));
        this._bus.emit({ type: "chunk:fatal", session, chunk, error });
        await this._store.save(session);
        scheduler.recordFailure();
        return;
      }

      if (isCancelled()) return;

      chunk.status = "done";
      chunk.attempts++;
      // Recompute from source-of-truth rather than accumulating
      session.transferredBytes = getTransferredBytes(session);
      progress.confirmBytes(chunk.size);
      this._bus.emit({ type: "chunk:done", session, chunk });
      await this._store.save(session);
      scheduler.recordSuccess();
    };

    for (const chunk of chunks) {
      scheduler.push(uploadChunkTask(chunk));
    }

    await scheduler.drain();
    progress.stop();
    await reader.close();
    this._activeUploads.delete(session.id);

    // ── Post-drain reconciliation ─────────────────────────────────────────
    if (isCancelled() || session.state === "cancelled") {
      this._cancelFlags.delete(session.id);
      if (session.state !== "cancelled") {
        transitionSession(session, "cancelled");
        session.updatedAt = Date.now();
      }
      this._bus.emit({ type: "session:cancelled", session });
      await this._store.save(session);
      await this._adapter.abortTransfer(session).catch(() => undefined);
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
      await this._adapter.abortTransfer(session).catch(() => undefined);
      return session;
    }

    return this._complete(session);
  }

  /**
   * Finalize the upload by calling adapter.completeTransfer().
   */
  private async _complete(session: TransferSession): Promise<TransferSession> {
    try {
      await this._adapter.completeTransfer(session, session.chunks);
    } catch (err) {
      transitionSession(session, "failed");
      session.updatedAt = Date.now();
      const error = err instanceof Error ? err : new Error(String(err));
      this._bus.emit({ type: "session:failed", session, error });
      await this._store.save(session);
      await this._adapter.abortTransfer(session).catch(() => undefined);
      return session;
    }

    transitionSession(session, "done");
    session.updatedAt = Date.now();
    this._bus.emit({ type: "session:done", session });
    this._bus.emit({
      type: "log",
      level: "info",
      message: `[TransferX] Session ${session.id} completed successfully`,
      context: { sessionId: session.id, totalBytes: session.file.size },
    });
    await this._store.save(session);
    return session;
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
