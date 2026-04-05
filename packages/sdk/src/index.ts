/**
 * @module @transferx/sdk
 *
 * Public entry point for the TransferX SDK.
 *
 * This package is the recommended integration target for application code.
 * It re-exports the complete public surface of @transferx/core plus the
 * pre-built adapters, and provides convenience factory functions that wire
 * everything together in a single call.
 *
 * Factories:
 *   - createB2Engine()  — Backblaze B2
 *   - createS3Engine()  — AWS S3
 *   - createR2Engine()  — Cloudflare R2
 *
 * Usage (B2):
 *
 *   ```typescript
 *   import { createB2Engine, makeUploadSession } from '@transferx/sdk';
 *   import * as fs from 'fs';
 *
 *   const { upload, bus, config, store } = createB2Engine({
 *     b2: {
 *       applicationKeyId: process.env.B2_APPLICATION_KEY_ID!,
 *       applicationKey:   process.env.B2_APP_KEY!,
 *       bucketId:         process.env.B2_BUCKET_ID!,
 *     },
 *   });
 *
 *   const stat = fs.statSync('/path/to/video.mp4');
 *   const session = makeUploadSession('upload-01', {
 *     name: 'video.mp4', size: stat.size, mimeType: 'video/mp4',
 *     path: '/path/to/video.mp4',
 *   }, 'uploads/2024/video.mp4', config);
 *
 *   await store.save(session);
 *   const result = await upload(session);
 *   console.log('Done:', result.state);
 *   ```
 *
 * Usage (S3):
 *
 *   ```typescript
 *   import { createS3Engine, makeUploadSession } from '@transferx/sdk';
 *
 *   const { upload, bus, config, store } = createS3Engine({
 *     s3: {
 *       bucket:      process.env.S3_BUCKET!,
 *       region:      'us-east-1',
 *       credentials: {
 *         accessKeyId:     process.env.AWS_ACCESS_KEY_ID!,
 *         secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
 *       },
 *     },
 *   });
 *   ```
 *
 * Usage (R2):
 *
 *   ```typescript
 *   import { createR2Engine, makeUploadSession } from '@transferx/sdk';
 *
 *   const { upload, bus, config, store } = createR2Engine({
 *     r2: {
 *       accountId:   process.env.CF_ACCOUNT_ID!,
 *       bucket:      process.env.R2_BUCKET!,
 *       credentials: {
 *         accessKeyId:     process.env.R2_ACCESS_KEY_ID!,
 *         secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
 *       },
 *     },
 *   });
 *   ```
 */

// ── Re-export the full core surface ───────────────────────────────────────────

export * from "@transferx/core";

// ── Re-export the B2 adapter ──────────────────────────────────────────────────

export { B2Adapter } from "@transferx/adapter-b2";
export type { B2AdapterOptions } from "@transferx/adapter-b2";

// ── Re-export the S3 / R2 adapters ────────────────────────────────────────────

export { S3Adapter, R2Adapter } from "@transferx/adapter-s3";
export type { S3AdapterOptions, R2AdapterOptions } from "@transferx/adapter-s3";

// ── Re-export the downloader public surface ────────────────────────────────────
// Users only need to install @transferx/sdk — the downloader is included.

export {
  DownloadEngine,
  DownloadTask,
  createDownloadTask,
  DownloadManager,
  DownloadMetrics,
  FetchHttpClient,
  PooledHttpClient,
  createHttpClient,
  isUndiciAvailable,
} from "@transferx/downloader";
export type {
  DownloadConfig,
  DownloadSession,
  ChunkMeta,
  DownloadProgress,
  DownloadStatus,
  ChunkStatus,
  ErrorCategory,
  ServerCapability,
  ConcurrencyPolicy,
  RetryPolicy,
  DownloadResult,
  DownloadEngineTask,
  DownloadManagerOptions,
  DownloadManagerStatus,
  ManagedDownload,
  DownloadMetricsSnapshot,
  IHttpClient,
  IHttpResponse,
  IHttpRequestOptions,
  ConnectionStats,
} from "@transferx/downloader";

// ── Shared imports ────────────────────────────────────────────────────────────

import { B2Adapter } from "@transferx/adapter-b2";
import type { B2AdapterOptions } from "@transferx/adapter-b2";
import { S3Adapter, R2Adapter } from "@transferx/adapter-s3";
import type { S3AdapterOptions, R2AdapterOptions } from "@transferx/adapter-s3";
import { UploadEngine } from "@transferx/core";
import { EventBus } from "@transferx/core";
import { resolveEngineConfig } from "@transferx/core";
import type { EngineConfig, TransferSession } from "@transferx/core";
import type { ISessionStore } from "@transferx/core";

// ── Completion metadata ───────────────────────────────────────────────────────

/**
 * Structured payload emitted when a single upload session finishes successfully.
 * Use this in your `onCompleted` callback to create EpisodeMedia or similar
 * database records without parsing raw bus events.
 *
 * @example
 * ```typescript
 * const { upload } = createB2Engine({
 *   b2: { ... },
 *   store: new FileSessionStore('.sessions'),
 *   onCompleted: async (meta) => {
 *     await db.episodeMedia.create({
 *       episodeId: myEpisodeId,
 *       storageKey: meta.remoteKey,
 *       fileSizeBytes: meta.fileSizeBytes,
 *       durationMs: meta.durationMs,
 *       manifestChecksum: meta.manifestChecksum,
 *     });
 *   },
 * });
 * ```
 */
export interface CompletedUploadMeta {
  /** Session ID — stable across retries and restarts. */
  sessionId: string;
  /** Absolute local file path (Node.js). `undefined` in browser context. */
  localPath: string | undefined;
  /** Remote object key (path on the storage provider). */
  remoteKey: string;
  /** File size in bytes. */
  fileSizeBytes: number;
  /** MIME type of the uploaded file. */
  mimeType: string;
  /** Epoch ms when the session was created (first `upload()` call). */
  createdAt: number;
  /** Epoch ms when the upload fully completed and the provider confirmed. */
  completedAt: number;
  /** Upload wall-clock duration in milliseconds (completedAt − createdAt). */
  durationMs: number;
  /** Total number of parts (chunks) uploaded. */
  chunkCount: number;
  /**
   * SHA-256 of concatenated sorted per-chunk checksums — deterministic
   * integrity fingerprint of all uploaded parts.  `undefined` when
   * `checksumVerify` is disabled in the engine config.
   */
  manifestChecksum: string | undefined;
  /** The raw `TransferSession` — for advanced use or full DB persistence. */
  session: TransferSession;
}

/** Build a CompletedUploadMeta from a finished TransferSession. */
function _makeCompletedMeta(session: TransferSession): CompletedUploadMeta {
  const completedAt = session.completedAt ?? session.updatedAt;
  return {
    sessionId: session.id,
    localPath: session.file.path,
    remoteKey: session.targetKey,
    fileSizeBytes: session.file.size,
    mimeType: session.file.mimeType,
    createdAt: session.createdAt,
    completedAt,
    durationMs: completedAt - session.createdAt,
    chunkCount: session.chunks.length,
    manifestChecksum: session.manifestChecksum,
    session,
  };
}

/** Wire onCompleted to the bus, swallowing callback errors so they don't crash uploads. */
function _wireOnCompleted(
  bus: EventBus,
  onCompleted: (meta: CompletedUploadMeta) => void | Promise<void>,
): void {
  bus.on("session:done", (event) => {
    Promise.resolve(onCompleted(_makeCompletedMeta(event.session))).catch(
      (err) => {
        bus.emit({
          type: "log",
          level: "error",
          message: `[TransferX] onCompleted callback threw for session ${event.session.id}: ${err instanceof Error ? err.message : String(err)}`,
          context: { sessionId: event.session.id },
        });
      },
    );
  });
}

// ── Shared engine shape ───────────────────────────────────────────────────────

/**
 * A fully-wired UploadEngine — returned by all createXxxEngine() factories.
 * Subscribe to `bus` for events; call `upload()` or `resumeSession()` to transfer.
 */
export interface EngineHandle {
  /** Upload a new session from scratch. Returns final TransferSession. */
  upload: UploadEngine["upload"];
  /** Resume a persisted session — reconciles remote state then re-uploads pending chunks. */
  resumeSession: UploadEngine["resumeSession"];
  /** Pause an in-process upload (in-flight chunks complete; no new chunks dispatched). */
  pause: UploadEngine["pause"];
  /** Resume an in-process paused scheduler (use resumeSession for crash recovery). */
  resumeScheduler: UploadEngine["resumeScheduler"];
  /** Cancel an active or persisted session. Best-effort remote abort. */
  cancel: UploadEngine["cancel"];
  /** Return the current persisted state of a session (null if not found). */
  getSession: UploadEngine["getSession"];
  /** Typed event bus — subscribe here for progress, lifecycle, and log events. */
  bus: EventBus;
  /** Fully resolved engine config (with defaults applied). */
  config: EngineConfig;
  /** The session store in use. Call store.listAll() to enumerate sessions on restart. */
  store: ISessionStore;
}

// Helper to wire onLog → bus without duplicating it three times
function _makeLogFn(
  bus: EventBus,
): (
  level: Parameters<NonNullable<B2AdapterOptions["onLog"]>>[0],
  message: string,
  context?: Record<string, unknown>,
) => void {
  return (level, message, context) =>
    bus.emit(
      context !== undefined
        ? { type: "log", level, message, context }
        : { type: "log", level, message },
    );
}

// ── Backblaze B2 factory ──────────────────────────────────────────────────────

export interface CreateB2EngineOptions {
  /** B2 credentials and target bucket. */
  b2: B2AdapterOptions;
  /**
   * Partial engine config — missing fields use defaults
   * (10 MiB chunks, 4 concurrent, 5 retries).
   */
  config?: Partial<EngineConfig>;
  /**
   * Durable session store. **Required.**
   * Use `FileSessionStore` from `@transferx/core` for crash-safe persistence
   * that survives process restarts. This is mandatory for production uploads
   * because without persistence, any crash or restart loses all progress.
   *
   * @example
   * ```typescript
   * import { FileSessionStore } from '@transferx/core';
   * store: new FileSessionStore('/absolute/path/to/.transferx-sessions')
   * ```
   */
  store: ISessionStore;
  /**
   * File-stat callback for change detection on resume.
   * When provided, `resumeSession()` compares the file's current `mtimeMs`
   * against the value stored in the session and throws `fileChangedError` if
   * the file has been modified since the session was created.
   *
   * @example
   * import { stat } from 'fs/promises';
   * fileStatFn: (path) => stat(path)
   */
  fileStatFn?: (path: string) => Promise<{ mtimeMs: number }>;
  /**
   * Called once after each upload session completes successfully.
   * Receives a structured metadata payload suitable for creating DB records
   * (e.g. EpisodeMedia) without parsing raw bus events.
   * Errors thrown inside this callback are caught and emitted as 'log' events
   * — they will NOT fail or cancel the upload.
   *
   * @example
   * onCompleted: async (meta) => {
   *   await db.episodeMedia.create({ storageKey: meta.remoteKey, fileSizeBytes: meta.fileSizeBytes });
   * }
   */
  onCompleted?: (meta: CompletedUploadMeta) => void | Promise<void>;
}

/** @deprecated Use {@link EngineHandle} — B2Engine is an alias kept for backwards compat. */
export type B2Engine = EngineHandle;

/**
 * Create a fully-wired UploadEngine configured for Backblaze B2.
 * This is the recommended starting point for B2 integrations.
 */
export function createB2Engine(opts: CreateB2EngineOptions): EngineHandle {
  const config = resolveEngineConfig(opts.config ?? {});
  const bus = new EventBus();
  const store = opts.store;
  const adapter = new B2Adapter({
    ...opts.b2,
    onLog: _makeLogFn(bus),
  });

  const engine = new UploadEngine({
    adapter,
    store,
    bus,
    config: opts.config ?? {},
    ...(opts.fileStatFn !== undefined ? { fileStatFn: opts.fileStatFn } : {}),
  });

  if (opts.onCompleted) _wireOnCompleted(bus, opts.onCompleted);

  return {
    upload: engine.upload.bind(engine),
    resumeSession: engine.resumeSession.bind(engine),
    pause: engine.pause.bind(engine),
    resumeScheduler: engine.resumeScheduler.bind(engine),
    cancel: engine.cancel.bind(engine),
    getSession: engine.getSession.bind(engine),
    bus,
    config,
    store,
  };
}

// ── AWS S3 factory ────────────────────────────────────────────────────────────

export interface CreateS3EngineOptions {
  /** S3 connection options (bucket, region, credentials, etc.). */
  s3: S3AdapterOptions;
  /** Partial engine config — missing fields use defaults. */
  config?: Partial<EngineConfig>;
  /**
   * Durable session store. **Required.**
   * @see {@link CreateB2EngineOptions.store}
   */
  store: ISessionStore;
  /**
   * File-stat callback for change detection on resume.
   * @see {@link CreateB2EngineOptions.fileStatFn}
   */
  fileStatFn?: (path: string) => Promise<{ mtimeMs: number }>;
  /**
   * Called once after each upload session completes successfully.
   * @see {@link CreateB2EngineOptions.onCompleted}
   */
  onCompleted?: (meta: CompletedUploadMeta) => void | Promise<void>;
}

/**
 * Create a fully-wired UploadEngine configured for AWS S3.
 *
 * @example
 * ```typescript
 * import { createS3Engine, makeUploadSession, FileSessionStore } from '@transferx/sdk';
 *
 * const { upload, bus, config, store } = createS3Engine({
 *   s3: {
 *     bucket:      'my-bucket',
 *     region:      'us-east-1',
 *     credentials: {
 *       accessKeyId:     process.env.AWS_ACCESS_KEY_ID!,
 *       secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
 *     },
 *   },
 *   store: new FileSessionStore('./.transferx-sessions'),
 * });
 * ```
 */
export function createS3Engine(opts: CreateS3EngineOptions): EngineHandle {
  const config = resolveEngineConfig(opts.config ?? {});
  const bus = new EventBus();
  const store = opts.store;
  const adapter = new S3Adapter({
    ...opts.s3,
    onLog: _makeLogFn(bus),
  });

  const engine = new UploadEngine({
    adapter,
    store,
    bus,
    config: opts.config ?? {},
    ...(opts.fileStatFn !== undefined ? { fileStatFn: opts.fileStatFn } : {}),
  });

  if (opts.onCompleted) _wireOnCompleted(bus, opts.onCompleted);

  return {
    upload: engine.upload.bind(engine),
    resumeSession: engine.resumeSession.bind(engine),
    pause: engine.pause.bind(engine),
    resumeScheduler: engine.resumeScheduler.bind(engine),
    cancel: engine.cancel.bind(engine),
    getSession: engine.getSession.bind(engine),
    bus,
    config,
    store,
  };
}

// ── Cloudflare R2 factory ─────────────────────────────────────────────────────

export interface CreateR2EngineOptions {
  /** R2 connection options (accountId, bucket, credentials). */
  r2: R2AdapterOptions;
  /** Partial engine config — missing fields use defaults. */
  config?: Partial<EngineConfig>;
  /**
   * Durable session store. **Required.**
   * @see {@link CreateB2EngineOptions.store}
   */
  store: ISessionStore;
  /**
   * File-stat callback for change detection on resume.
   * @see {@link CreateB2EngineOptions.fileStatFn}
   */
  fileStatFn?: (path: string) => Promise<{ mtimeMs: number }>;
  /**
   * Called once after each upload session completes successfully.
   * @see {@link CreateB2EngineOptions.onCompleted}
   */
  onCompleted?: (meta: CompletedUploadMeta) => void | Promise<void>;
}

/**
 * Create a fully-wired UploadEngine configured for Cloudflare R2.
 * Endpoint, region, and forcePathStyle are set automatically.
 *
 * @example
 * ```typescript
 * import { createR2Engine, makeUploadSession, FileSessionStore } from '@transferx/sdk';
 *
 * const { upload, bus, config, store } = createR2Engine({
 *   r2: {
 *     accountId:   process.env.CF_ACCOUNT_ID!,
 *     bucket:      'my-r2-bucket',
 *     credentials: {
 *       accessKeyId:     process.env.R2_ACCESS_KEY_ID!,
 *       secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
 *     },
 *   },
 *   store: new FileSessionStore('./.transferx-sessions'),
 * });
 * ```
 */
export function createR2Engine(opts: CreateR2EngineOptions): EngineHandle {
  const config = resolveEngineConfig(opts.config ?? {});
  const bus = new EventBus();
  const store = opts.store;
  const adapter = new R2Adapter({
    ...opts.r2,
    onLog: _makeLogFn(bus),
  });

  const engine = new UploadEngine({
    adapter,
    store,
    bus,
    config: opts.config ?? {},
    ...(opts.fileStatFn !== undefined ? { fileStatFn: opts.fileStatFn } : {}),
  });

  if (opts.onCompleted) _wireOnCompleted(bus, opts.onCompleted);

  return {
    upload: engine.upload.bind(engine),
    resumeSession: engine.resumeSession.bind(engine),
    pause: engine.pause.bind(engine),
    resumeScheduler: engine.resumeScheduler.bind(engine),
    cancel: engine.cancel.bind(engine),
    getSession: engine.getSession.bind(engine),
    bus,
    config,
    store,
  };
}

// ── Re-export HTTP adapter ────────────────────────────────────────────────────

export { HttpAdapter, createHttpAdapter } from "@transferx/adapter-http";
export type { HttpAdapterOptions } from "@transferx/adapter-http";

// ── Generic HTTP upload factory ────────────────────────────────────────────────

import { HttpAdapter } from "@transferx/adapter-http";
import type { HttpAdapterOptions } from "@transferx/adapter-http";

export interface CreateHttpEngineOptions {
  /**
   * Callback functions that implement the HTTP upload protocol.
   * All network/credential concerns are entirely the responsibility of these
   * caller-supplied implementations — the SDK never inspects the payloads.
   */
  http: HttpAdapterOptions;
  /** Partial engine config — missing fields use defaults (10 MiB chunks, 4 concurrent, 5 retries). */
  config?: Partial<EngineConfig>;
  /**
   * Durable session store. **Required.**
   * @see {@link CreateB2EngineOptions.store}
   */
  store: ISessionStore;
  /**
   * File-stat callback for change detection on resume.
   * @see {@link CreateB2EngineOptions.fileStatFn}
   */
  fileStatFn?: (path: string) => Promise<{ mtimeMs: number }>;
  /**
   * Called once after each upload session completes successfully.
   * @see {@link CreateB2EngineOptions.onCompleted}
   */
  onCompleted?: (meta: CompletedUploadMeta) => void | Promise<void>;
}

/**
 * Create a fully-wired UploadEngine backed by custom HTTP callbacks.
 * Use this when you have your own multipart upload API and don't need a
 * dedicated adapter (B2/S3/R2).
 *
 * @example
 * ```typescript
 * import { createHttpEngine, makeUploadSession } from '@transferx/sdk';
 *
 * const { upload, bus, config } = createHttpEngine({
 *   http: {
 *     initFn:     async (session) => myApi.createUpload(session.targetKey),
 *     uploadFn:   async (session, chunk, data) => myApi.uploadPart(session.providerSessionId!, chunk.index + 1, data),
 *     completeFn: async (session, chunks) => myApi.completeUpload(session.providerSessionId!, chunks),
 *     abortFn:    async (session) => myApi.abortUpload(session.providerSessionId!),
 *   },
 * });
 * ```
 */
export function createHttpEngine(opts: CreateHttpEngineOptions): EngineHandle {
  const config = resolveEngineConfig(opts.config ?? {});
  const bus = new EventBus();
  const store = opts.store;
  const adapter = new HttpAdapter(opts.http);

  const engine = new UploadEngine({
    adapter,
    store,
    bus,
    config: opts.config ?? {},
    ...(opts.fileStatFn !== undefined ? { fileStatFn: opts.fileStatFn } : {}),
  });

  if (opts.onCompleted) _wireOnCompleted(bus, opts.onCompleted);

  return {
    upload: engine.upload.bind(engine),
    resumeSession: engine.resumeSession.bind(engine),
    pause: engine.pause.bind(engine),
    resumeScheduler: engine.resumeScheduler.bind(engine),
    cancel: engine.cancel.bind(engine),
    getSession: engine.getSession.bind(engine),
    bus,
    config,
    store,
  };
}

// ── Startup recovery helper ──────────────────────────────────────────────────

/**
 * Scan a session store and resume every non-terminal (non-done, non-cancelled)
 * session via the provided engine.
 *
 * Call this **once at startup** to recover any in-progress uploads that were
 * interrupted by a process crash or restart.
 *
 * Resumes are throttled by `options.maxConcurrent` (default: 4) so that a store
 * with hundreds of failed sessions does not fire hundreds of simultaneous HTTP
 * connections. Excess sessions wait until a slot opens.
 *
 * For richer back-pressure control use `TransferManager.restoreFromStore()`
 * instead — it respects `maxConcurrentUploads` automatically.
 *
 * @example
 * ```typescript
 * import { createB2Engine, FileSessionStore, restoreAllSessions } from '@transferx/sdk';
 *
 * const store = new FileSessionStore('./.transferx-sessions');
 * const engine = createB2Engine({
 *   b2: { applicationKeyId: '...', applicationKey: '...', bucketId: '...' },
 *   store,
 *   onCompleted: async (meta) => { /* create DB record *\/ },
 * });
 *
 * // On every startup — resume up to 4 sessions concurrently:
 * const { resuming, skipped } = await restoreAllSessions(store, engine);
 * console.log(`Resuming ${resuming.length} session(s), skipped ${skipped.length} already-done.`);
 * ```
 */
export async function restoreAllSessions(
  store: ISessionStore,
  engine: Pick<EngineHandle, "resumeSession">,
  options?: {
    /**
     * Maximum number of concurrent `resumeSession()` calls in flight at once.
     * Prevents a large store from saturating network connections on startup.
     * Default: 4
     */
    maxConcurrent?: number;
  },
): Promise<{ resuming: string[]; skipped: string[] }> {
  const maxConcurrent = Math.max(1, options?.maxConcurrent ?? 4);
  const sessions = await store.listAll();
  const resuming: string[] = [];
  const skipped: string[] = [];
  const toResume: string[] = [];

  for (const session of sessions) {
    if (session.state === "done" || session.state === "cancelled") {
      skipped.push(session.id);
    } else {
      toResume.push(session.id);
    }
  }

  // Throttled async pool: never more than maxConcurrent resumes in-flight.
  await new Promise<void>((resolve) => {
    if (toResume.length === 0) {
      resolve();
      return;
    }

    let active = 0;
    let index = 0;
    let settled = 0;

    function dispatch(): void {
      while (active < maxConcurrent && index < toResume.length) {
        const id = toResume[index++]!;
        resuming.push(id);
        active++;
        engine
          .resumeSession(id)
          .catch(() => undefined)
          .finally(() => {
            active--;
            settled++;
            if (settled === toResume.length) {
              resolve();
            } else {
              dispatch();
            }
          });
      }
    }

    dispatch();
  });

  return { resuming, skipped };
}

// ── HTTP Downloader factory ───────────────────────────────────────────────────

import { DownloadEngine, DownloadTask } from "@transferx/downloader";
import type { DownloadConfig } from "@transferx/downloader";

export interface CreateDownloaderOptions {
  /** Target URL to download from. */
  url: string;
  /**
   * Absolute (or relative) path where the file will be written.
   * The parent directory is created automatically.
   */
  outputPath: string;
  /**
   * Downloader configuration.
   * Defaults: chunkSize=10 MiB, concurrency.initial=8, retry.maxAttempts=5,
   *           timeoutMs=120_000, progressIntervalMs=200.
   */
  config?: Partial<DownloadConfig>;
  /**
   * Directory for persisted session state (crash recovery).
   * Defaults to ".transferx-downloads". Use an absolute path for reliable
   * restart recovery in long-running processes.
   */
  storeDir?: string;
}

/**
 * Create a ready-to-start download task. The recommended entry point for
 * download operations in the TransferX SDK.
 *
 * @example
 * ```typescript
 * import { createDownloader } from '@transferx/sdk';
 *
 * const task = createDownloader({
 *   url: 'https://example.com/large-file.zip',
 *   outputPath: '/downloads/large-file.zip',
 *   config: { concurrency: { initial: 8 } },
 *   storeDir: './.transferx-downloads',
 * });
 *
 * task.on('progress', (p) => {
 *   const speed = (p.speedBytesPerSec / 1e6).toFixed(1);
 *   console.log(`${p.percent?.toFixed(1) ?? '?'}%  ${speed} MB/s`);
 * });
 * task.on('completed', ({ session }) => {
 *   console.log('Downloaded to', session.outputPath);
 * });
 *
 * await task.start();
 * ```
 *
 * Resume after crash:
 * ```typescript
 * import { DownloadEngine, DownloadTask } from '@transferx/sdk';
 *
 * const engine = new DownloadEngine({ storeDir: './.transferx-downloads' });
 * for (const session of await engine.listSessions()) {
 *   const inner = await engine.resumeTask(session.id);
 *   if (inner) await new DownloadTask(inner).start();
 * }
 * ```
 */
export function createDownloader(opts: CreateDownloaderOptions): DownloadTask {
  const engine = new DownloadEngine({
    ...(opts.config !== undefined ? { config: opts.config } : {}),
    ...(opts.storeDir !== undefined ? { storeDir: opts.storeDir } : {}),
  });
  const inner = engine.createTask(opts.url, opts.outputPath);
  return new DownloadTask(inner);
}
