/**
 * @module DownloadEngine
 *
 * Top-level orchestrator that wires every downloader subsystem together.
 *
 * Lifecycle of a single download:
 *
 *   1. createTask(url, outputPath) → DownloadTaskHandle (internal)
 *      Client calls task.start() / .pause() / .resume() / .cancel()
 *
 *   2. On start():
 *      a. CapabilityDetector.detect(url)
 *         → emits "capability-detected" log event
 *      b. Check for existing DownloadSession (ResumeStore.load(id))
 *         → if found: validate etag/lastModified; if mismatch → staleError
 *         → if found & valid: RangePlanner.rehydrate()
 *         → if not found: RangePlanner.plan()
 *      c. FileWriter.open(fileSize, isResume)
 *      d. ProgressEngine.start()
 *      e. ChunkScheduler.push() for each pending chunk
 *      f. ChunkScheduler.drain() — waits for all completions
 *      g. FileWriter.flush() + FileWriter.close()
 *      h. ResumeStore.delete() (session fully committed)
 *      i. emit "completed"; return final DownloadSession
 *
 *   3. Each chunk task:
 *      a. Mark chunk "running"; persist; emit "chunk-start"
 *      b. withRetry(() => _downloadChunk(chunk, signal), ...)
 *         → fetch with Range header (or no Range for streaming chunks)
 *         → expect 206 (or 200 for streaming chunks)
 *         → FileWriter.writeStream(body, chunk.start, onBytes)
 *         → mark "done"; persist; emit "chunk-complete"
 *      c. On error (retries exhausted): mark "fatal"; persist; emit "error"
 *         → abort all pending work
 *
 * Session ID:
 *   Deterministically derived as `sha256(url + outputPath)` (hex, first 16
 *   chars). Same URL+path always maps to the same session, enabling crash
 *   recovery without the caller tracking IDs.
 *
 * Pause / Resume:
 *   pause()   → ChunkScheduler.pause() (in-flight chunks complete normally)
 *   resume()  → ChunkScheduler.resume() (re-queues nothing — pending chunks
 *               were queued before the drain completed and are still in the
 *               scheduler queue)
 *
 * Cancel:
 *   Sets the cancellation AbortController; the AbortSignal is passed into
 *   every withRetry call and every fetch call. Active fetches abort at the
 *   next response chunk boundary. ChunkScheduler.cancel() clears the queue.
 *   The partial session file is kept on disk so the user can resume later
 *   if they change their mind (the session status is set to "cancelled").
 */

import * as crypto from "crypto";
import type { DownloadConfig, DownloadSession, ChunkMeta } from "./types.js";
import {
  resolveDownloadConfig,
  DownloadError,
  httpError,
  networkError,
  timeoutError,
  staleError,
  diskError,
} from "./types.js";
import { DownloadEventBus } from "./EventBus.js";
import { CapabilityDetector } from "./CapabilityDetector.js";
import { RangePlanner } from "./RangePlanner.js";
import { FileWriter } from "./FileWriter.js";
import { ResumeStore } from "./ResumeStore.js";
import { withRetry } from "./RetryEngine.js";
import { ProgressEngine } from "./ProgressEngine.js";
import { ChunkScheduler } from "./ChunkScheduler.js";
import { BufferPool } from "./BufferPool.js";

// Conservative resume granularity: round bytesWritten down to 1 MiB
// boundaries before requesting partial chunks. This bounds potential discrepancy
// between kernel write-back cache and guaranteed-on-disk data to ≤ 1 MiB.
// pwrite() semantics make any overlap safe (idempotent overwrite).
const RESUME_GRANULARITY = 1 * 1024 * 1024;

// ─── Public types ─────────────────────────────────────────────────────────────

export interface DownloadResult {
  session: DownloadSession;
}

// ─── Internal per-task state ──────────────────────────────────────────────────

export interface DownloadEngineTask {
  readonly id: string;
  readonly url: string;
  readonly outputPath: string;
  readonly bus: DownloadEventBus;
  start(): Promise<DownloadResult>;
  pause(): void;
  resume(): void;
  cancel(): Promise<void>;
  getSession(): DownloadSession | null;
}

// ─── Engine ───────────────────────────────────────────────────────────────────

export class DownloadEngine {
  private readonly _config: DownloadConfig;
  private readonly _store: ResumeStore;

  constructor(
    opts: {
      config?: Partial<DownloadConfig>;
      storeDir?: string;
    } = {},
  ) {
    this._config = resolveDownloadConfig(opts.config ?? {});
    this._store = new ResumeStore(opts.storeDir ?? ".transferx-downloads");
  }

  /**
   * Create a new download task for the given URL and output path.
   * No network activity happens until task.start() is called.
   */
  createTask(url: string, outputPath: string): DownloadEngineTask {
    const id = deriveSessionId(url, outputPath);
    return new InternalTask(id, url, outputPath, this._config, this._store);
  }

  /**
   * Load a persisted session by ID and create a resumable task.
   * Returns null if no session exists for the given ID.
   */
  async resumeTask(sessionId: string): Promise<DownloadEngineTask | null> {
    const session = await this._store.load(sessionId);
    if (!session) return null;
    return new InternalTask(
      session.id,
      session.url,
      session.outputPath,
      this._config,
      this._store,
    );
  }

  /**
   * List all persisted (incomplete) sessions from the store.
   */
  async listSessions(): Promise<DownloadSession[]> {
    return this._store.listAll();
  }
}

// ─── InternalTask ─────────────────────────────────────────────────────────────

class InternalTask implements DownloadEngineTask {
  readonly id: string;
  readonly url: string;
  readonly outputPath: string;
  readonly bus: DownloadEventBus;

  private readonly _config: DownloadConfig;
  private readonly _store: ResumeStore;
  private _session: DownloadSession | null = null;
  private _scheduler: ChunkScheduler | null = null;
  private _progress: ProgressEngine | null = null;
  private _abortController: AbortController | null = null;

  constructor(
    id: string,
    url: string,
    outputPath: string,
    config: DownloadConfig,
    store: ResumeStore,
  ) {
    this.id = id;
    this.url = url;
    this.outputPath = outputPath;
    this._config = config;
    this._store = store;
    this.bus = new DownloadEventBus();
  }

  getSession(): DownloadSession | null {
    return this._session;
  }

  pause(): void {
    this._scheduler?.pause();
    if (this._session) {
      this._session = { ...this._session, status: "paused" };
      // Fire-and-forget persist — pause is best-effort
      void this._store.save(this._session).catch(() => undefined);
    }
    this.bus.emit("pause", { taskId: this.id });
  }

  resume(): void {
    this._scheduler?.resume();
    if (this._session) {
      this._session = { ...this._session, status: "running" };
    }
    this.bus.emit("resume", { taskId: this.id });
  }

  async cancel(): Promise<void> {
    this._abortController?.abort();
    await this._scheduler?.cancel();
    if (this._session) {
      this._session = {
        ...this._session,
        status: "cancelled",
        updatedAt: Date.now(),
      };
      await this._store.save(this._session).catch(() => undefined);
    }
    this.bus.emit("cancelled", { taskId: this.id });
  }

  async start(): Promise<DownloadResult> {
    this._abortController = new AbortController();
    const signal = this._abortController.signal;

    this.bus.emit("start", { taskId: this.id });

    // ── 1. Capability detection ──────────────────────────────────────────────
    const detector = new CapabilityDetector(this._config);
    let capabilities;
    try {
      capabilities = await detector.detect(this.url);
    } catch (err) {
      const dlErr = toDlError(err);
      this.bus.emit("error", { taskId: this.id, error: dlErr });
      throw dlErr;
    }

    this.bus.emit("log", {
      taskId: this.id,
      level: "info",
      message: `Capability probe: supportsRange=${capabilities.supportsRange}, fileSize=${capabilities.fileSize ?? "unknown"}, etag=${capabilities.etag ?? "none"}`,
    });

    // ── 2. Session bootstrap (resume or fresh) ───────────────────────────────
    let session = await this._store.load(this.id);
    let isResume = false;

    if (session) {
      // Validate that server artifact hasn't changed since session was saved
      const mismatch = detectStaleness(session, capabilities);
      if (mismatch) {
        const err = staleError(
          `Cannot resume: server artifact has changed (${mismatch}). ` +
            `Delete the session to start fresh.`,
        );
        this.bus.emit("error", { taskId: this.id, error: err });
        throw err;
      }
      session = {
        ...session,
        chunks: RangePlanner.rehydrate(session.chunks),
        status: "running",
        updatedAt: Date.now(),
      };
      isResume = true;
      this.bus.emit("log", {
        taskId: this.id,
        level: "info",
        message: `Resuming session: ${RangePlanner.pendingChunks(session.chunks).length} chunk(s) remaining`,
      });
    } else {
      // Fresh download
      const chunks = RangePlanner.plan(
        capabilities.fileSize,
        this._config.chunkSize,
        capabilities.supportsRange,
      );
      session = {
        id: this.id,
        url: this.url,
        outputPath: this.outputPath,
        fileSize: capabilities.fileSize,
        etag: capabilities.etag,
        lastModified: capabilities.lastModified,
        supportsRange: capabilities.supportsRange,
        status: "running",
        chunks,
        downloadedBytes: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      if (!capabilities.supportsRange) {
        this.bus.emit("log", {
          taskId: this.id,
          level: "warn",
          message:
            "Server does not support range requests — falling back to single-stream mode. Resume will not be available.",
        });
      }
    }

    this._session = session;
    await this._store.save(session);

    // ── 3. File writer ──────────────────────────────────────────────────────
    const writer = new FileWriter(this.outputPath);
    await writer.open(capabilities.fileSize, isResume);

    // ── 4. Progress engine ──────────────────────────────────────────────────
    const resumedBytes = session.downloadedBytes;
    const progress = new ProgressEngine({
      taskId: this.id,
      totalBytes: capabilities.fileSize,
      downloadedBytes: resumedBytes,
      progressIntervalMs: this._config.progressIntervalMs,
      onProgress: (p) => this.bus.emit("progress", p),
    });
    this._progress = progress;
    progress.start();

    // ── 5. Schedule chunks ──────────────────────────────────────────────────
    const scheduler = new ChunkScheduler(this._config.concurrency);
    this._scheduler = scheduler;

    // Shared write-coalescing pool: one buffer per active connection.
    // Reduces fs.write() syscall count and per-frame Buffer allocations.
    const pool = new BufferPool(
      256 * 1024,
      Math.max(4, this._config.concurrency.max * 2),
    );

    let fatalError: DownloadError | null = null;
    let completedSinceSync = 0;
    const fsyncInterval = this._config.fsyncIntervalChunks;

    const pendingChunks = RangePlanner.pendingChunks(session.chunks);

    for (const chunk of pendingChunks) {
      scheduler.push(async () => {
        if (fatalError || signal.aborted) return;

        // Mark running
        this._updateChunk(chunk.index, { status: "running" });
        this.bus.emit("chunkStart", {
          taskId: this.id,
          chunk: this._getChunk(chunk.index)!,
        });

        const t0 = Date.now();
        try {
          const bytesDownloaded = await withRetry(
            () => this._downloadChunk(chunk, writer, progress, signal, pool),
            this._config.retry,
            (err, attempt) => {
              scheduler.recordFailure();
              this.bus.emit("retry", {
                taskId: this.id,
                chunk: this._getChunk(chunk.index)!,
                error: err,
                attempt,
              });
            },
            signal,
          );

          // Chunk succeeded — update state.
          const isStreaming = RangePlanner.isStreamingChunk(chunk);
          const finalBytesWritten = isStreaming
            ? (this._getChunk(chunk.index)?.bytesWritten ?? bytesDownloaded)
            : chunk.size;
          this._updateChunk(chunk.index, {
            status: "done",
            bytesWritten: finalBytesWritten,
          });
          scheduler.recordSuccess();

          // Report throughput to the hill-climbing algorithm.
          const elapsedMs = Math.max(1, Date.now() - t0);
          if (bytesDownloaded > 0) {
            scheduler.addThroughputSample(bytesDownloaded / elapsedMs);
          }

          this.bus.emit("chunkComplete", {
            taskId: this.id,
            chunk: this._getChunk(chunk.index)!,
          });

          // Periodic fdatasync: flush every N completed chunks.
          // Reset counter before await to prevent concurrent triggers.
          completedSinceSync++;
          if (fsyncInterval > 0 && completedSinceSync >= fsyncInterval) {
            completedSinceSync = 0;
            await writer.flush().catch(() => undefined);
          }

          // Persist session after (potential) sync — session now reflects
          // bytes that are guaranteed on disk.
          if (this._session) {
            this._session = { ...this._session, updatedAt: Date.now() };
            await this._store.save(this._session).catch(() => undefined);
          }
        } catch (err) {
          const dlErr = toDlError(err);
          this._updateChunk(chunk.index, {
            status: dlErr.category === "cancelled" ? "failed" : "fatal",
          });
          scheduler.recordFailure();

          if (dlErr.category !== "cancelled") {
            fatalError = dlErr;
            // Abort all remaining work
            this._abortController?.abort();
            this.bus.emit("error", { taskId: this.id, error: dlErr });
          }
        }
      });
    }

    // ── 6. Wait for all chunks ───────────────────────────────────────────────
    await scheduler.drain();

    progress.finish();

    // ── 7. Finalise ─────────────────────────────────────────────────────────
    try {
      await writer.flush();
    } finally {
      await writer.close();
    }

    if (fatalError) {
      // Persist failed session state
      if (this._session) {
        this._session = {
          ...this._session,
          status: "failed",
          updatedAt: Date.now(),
        };
        await this._store.save(this._session).catch(() => undefined);
      }
      throw fatalError;
    }

    if (signal.aborted) {
      // cancel() already saved session with status=cancelled
      const err = new DownloadError({
        message: "Download cancelled",
        category: "cancelled",
      });
      throw err;
    }

    // Complete
    this._session = {
      ...this._session!,
      status: "completed",
      downloadedBytes:
        (this._session?.fileSize ?? 0) > 0
          ? this._session!.fileSize!
          : this._session!.downloadedBytes,
      updatedAt: Date.now(),
    };
    await this._store.delete(this.id); // session no longer needed

    this.bus.emit("completed", { taskId: this.id, session: this._session });
    return { session: this._session };
  }

  // ─── Core HTTP download for a single chunk ─────────────────────────────────

  /**
   * Download one chunk and write it to disk at the correct byte offset.
   *
   * Byte-level resume:
   *   Reads the live session bytesWritten (accumulated across retries), rounds
   *   it down to a 1 MiB boundary for kernel write-back safety, and requests
   *   only the remaining bytes via "Range: bytes=resumeStart-end".
   *   The write starts at the matching file offset so no bytes are ever
   *   double-counted and no gaps are created.
   *
   * @returns Bytes written during this invocation (excludes prior resume bytes).
   */
  private async _downloadChunk(
    chunk: ChunkMeta,
    writer: FileWriter,
    progress: ProgressEngine,
    signal: AbortSignal,
    pool: BufferPool,
  ): Promise<number> {
    const fetchFn = this._config.fetch ?? globalThis.fetch;
    const isStreaming = RangePlanner.isStreamingChunk(chunk);

    // Byte-level sub-chunk resume.
    // Use live session state (accounts for bytes written in prior retry attempts).
    // Round down to RESUME_GRANULARITY (1 MiB) to handle kernel write-back
    // cache uncertainty for cross-process crash-resume scenarios.
    const rawBytesWritten = this._getChunk(chunk.index)?.bytesWritten ?? 0;
    const resumeOffset =
      rawBytesWritten > 0
        ? rawBytesWritten - (rawBytesWritten % RESUME_GRANULARITY)
        : 0;

    // Align the in-session bytesWritten to the conservative resume baseline
    // so the onBytes callback starts accumulating from the right position.
    if (resumeOffset < rawBytesWritten) {
      this._updateChunk(chunk.index, { bytesWritten: resumeOffset });
    }

    const headers: Record<string, string> = { ...this._config.headers };
    if (!isStreaming) {
      // Request only the remaining bytes.
      const rangeStart = chunk.start + resumeOffset;
      headers["Range"] = `bytes=${rangeStart}-${chunk.end}`;
    }

    const timeoutSignal = AbortSignal.timeout(this._config.timeoutMs);
    const combinedSignal = anyAborted([signal, timeoutSignal]);

    let response: Response;
    try {
      response = await fetchFn(this.url, { headers, signal: combinedSignal });
    } catch (err: unknown) {
      const e = err as Error | undefined;
      if (e?.name === "AbortError" || e?.name === "TimeoutError") {
        if (signal.aborted) {
          throw new DownloadError({
            message: "Download cancelled",
            category: "cancelled",
          });
        }
        throw timeoutError(`Chunk ${chunk.index} timed out`, chunk.index);
      }
      throw networkError(
        `Chunk ${chunk.index} fetch failed: ${String(err)}`,
        chunk.index,
        err,
      );
    }

    // Validate status code.
    const expectedStatus = isStreaming ? 200 : 206;
    if (response.status !== expectedStatus) {
      if (!isStreaming && response.status === 200) {
        if (chunk.index > 0) {
          throw httpError(
            200,
            `Chunk ${chunk.index}: server returned 200 instead of 206 — range not honored`,
            chunk.index,
          );
        }
        // chunk 0 with full-file fallback — acceptable
      } else if (response.status !== expectedStatus) {
        throw httpError(
          response.status,
          `Chunk ${chunk.index}: HTTP ${response.status}`,
          chunk.index,
        );
      }
    }

    if (!response.body) {
      throw networkError(
        `Chunk ${chunk.index}: response body is null`,
        chunk.index,
      );
    }

    // File write starts at the resume offset within the chunk's extent.
    const writeStartOffset = isStreaming ? 0 : chunk.start + resumeOffset;

    // Stream directly to disk via write-coalescing pool.
    const written = await writer.writeStream(
      response.body,
      writeStartOffset,
      (bytes) => {
        this._updateChunk(chunk.index, {
          bytesWritten:
            (this._getChunk(chunk.index)?.bytesWritten ?? 0) + bytes,
        });
        progress.addBytes(bytes);
        if (this._session) {
          this._session = {
            ...this._session,
            downloadedBytes: this._session.downloadedBytes + bytes,
          };
        }
      },
      pool,
    );

    // For streaming chunks, report the final size to ProgressEngine.
    if (isStreaming) {
      progress.setTotalBytes(written);
    }

    return written;
  }

  // ─── Session helpers ────────────────────────────────────────────────────────

  private _getChunk(index: number): ChunkMeta | undefined {
    return this._session?.chunks[index];
  }

  private _updateChunk(index: number, update: Partial<ChunkMeta>): void {
    if (!this._session) return;
    const chunks = this._session.chunks.map((c) =>
      c.index === index ? { ...c, ...update } : c,
    );
    this._session = { ...this._session, chunks };
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * Derive a stable session ID from URL + output path using a short SHA-256.
 * 16 hex characters (8 bytes) — collision probability is negligible for
 * typical download queues.
 */
function deriveSessionId(url: string, outputPath: string): string {
  return crypto
    .createHash("sha256")
    .update(`${url}\0${outputPath}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Returns a description of what changed if the server artifact has been
 * modified since the session was persisted, or null if everything matches.
 */
function detectStaleness(
  session: DownloadSession,
  cap: {
    etag: string | null;
    lastModified: string | null;
    fileSize: number | null;
  },
): string | null {
  if (session.etag && cap.etag && session.etag !== cap.etag) {
    return `etag changed (${session.etag} → ${cap.etag})`;
  }
  if (
    !session.etag &&
    session.lastModified &&
    cap.lastModified &&
    session.lastModified !== cap.lastModified
  ) {
    return `last-modified changed (${session.lastModified} → ${cap.lastModified})`;
  }
  if (
    session.fileSize !== null &&
    cap.fileSize !== null &&
    session.fileSize !== cap.fileSize
  ) {
    return `content-length changed (${session.fileSize} → ${cap.fileSize})`;
  }
  return null;
}

/**
 * Create a composite AbortSignal that aborts when ANY of the given signals
 * abort. Polyfill for AbortSignal.any() (Node.js 20+) to keep Node 18 compat.
 */
function anyAborted(signals: AbortSignal[]): AbortSignal {
  // Fast path: native AbortSignal.any() is available in Node 20+
  if (typeof (AbortSignal as any).any === "function") {
    return (AbortSignal as any).any(signals);
  }
  const ctrl = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      ctrl.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => ctrl.abort(s.reason), { once: true });
  }
  return ctrl.signal;
}

/**
 * Coerce any thrown value into a DownloadError.
 */
function toDlError(err: unknown): DownloadError {
  if (err instanceof DownloadError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  return new DownloadError({ message: msg, category: "unknown", cause: err });
}
