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
} from "@transferx/downloader";

// ── Shared imports ────────────────────────────────────────────────────────────

import { B2Adapter } from "@transferx/adapter-b2";
import type { B2AdapterOptions } from "@transferx/adapter-b2";
import { S3Adapter, R2Adapter } from "@transferx/adapter-s3";
import type { S3AdapterOptions, R2AdapterOptions } from "@transferx/adapter-s3";
import { UploadEngine } from "@transferx/core";
import { EventBus } from "@transferx/core";
import { MemorySessionStore } from "@transferx/core";
import { resolveEngineConfig } from "@transferx/core";
import type { EngineConfig } from "@transferx/core";
import type { ISessionStore } from "@transferx/core";

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
   * Session store. Defaults to in-memory.
   * Use `FileSessionStore` from `@transferx/core` for crash-safe persistence.
   */
  store?: ISessionStore;
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
  const store = opts.store ?? new MemorySessionStore();
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
   * Session store. Defaults to in-memory.
   * Use `FileSessionStore` from `@transferx/core` for crash-safe persistence.
   */
  store?: ISessionStore;
  /**
   * File-stat callback for change detection on resume.
   * @see {@link CreateB2EngineOptions.fileStatFn}
   */
  fileStatFn?: (path: string) => Promise<{ mtimeMs: number }>;
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
  const store = opts.store ?? new MemorySessionStore();
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
   * Session store. Defaults to in-memory.
   * Use `FileSessionStore` from `@transferx/core` for crash-safe persistence.
   */
  store?: ISessionStore;
  /**
   * File-stat callback for change detection on resume.
   * @see {@link CreateB2EngineOptions.fileStatFn}
   */
  fileStatFn?: (path: string) => Promise<{ mtimeMs: number }>;
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
  const store = opts.store ?? new MemorySessionStore();
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
