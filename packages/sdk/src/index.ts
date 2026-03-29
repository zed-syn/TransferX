/**
 * @module @transferx/sdk
 *
 * Public entry point for the TransferX SDK.
 *
 * This package is the recommended integration target for application code.
 * It re-exports the complete public surface of @transferx/core plus the
 * pre-built adapters, and provides a convenience factory function that
 * wires everything together in a single call.
 *
 * Usage:
 *
 *   ```typescript
 *   import { createB2Engine, makeUploadSession } from '@transferx/sdk';
 *   import * as fs from 'fs';
 *
 *   const engine = createB2Engine({
 *     accountId: process.env.B2_ACCOUNT_ID!,
 *     applicationKey: process.env.B2_APP_KEY!,
 *     bucketId: process.env.B2_BUCKET_ID!,
 *   });
 *
 *   // Subscribe to progress events
 *   engine.bus.on('progress', ({ progress }) => {
 *     console.log(`${progress.percent.toFixed(1)}% — ${progress.speedBytesPerSec} B/s`);
 *   });
 *
 *   const stat = fs.statSync('/path/to/video.mp4');
 *   const config = engine.config;
 *
 *   const session = makeUploadSession('upload-01', {
 *     name: 'video.mp4',
 *     size: stat.size,
 *     mimeType: 'video/mp4',
 *     path: '/path/to/video.mp4',
 *   }, 'uploads/2024/video.mp4', config);
 *
 *   await engine.store.save(session);
 *   const result = await engine.upload(session);
 *   console.log('Done:', result.state);
 *   ```
 */

// ── Re-export the full core surface ───────────────────────────────────────────

export * from "@transferx/core";

// ── Re-export the B2 adapter ──────────────────────────────────────────────────

export { B2Adapter } from "@transferx/adapter-b2";
export type { B2AdapterOptions } from "@transferx/adapter-b2";

// ── Convenience factory ───────────────────────────────────────────────────────

import { B2Adapter } from "@transferx/adapter-b2";
import type { B2AdapterOptions } from "@transferx/adapter-b2";
import { UploadEngine } from "@transferx/core";
import { EventBus } from "@transferx/core";
import { MemorySessionStore } from "@transferx/core";
import { resolveEngineConfig } from "@transferx/core";
import type { EngineConfig } from "@transferx/core";
import type { ISessionStore } from "@transferx/core";

export interface CreateB2EngineOptions {
  /** B2 credentials and target bucket. */
  b2: B2AdapterOptions;
  /**
   * Partial engine config. Missing fields use sensible TypeScript-inferred
   * defaults (10 MiB chunks, 4 concurrent, 5 retries).
   */
  config?: Partial<EngineConfig>;
  /**
   * Custom session store. Defaults to an in-memory store.
   * For durability across restarts, use FileSessionStore from @transferx/core.
   */
  store?: ISessionStore;
}

/**
 * Result of createB2Engine — a wired-up engine ready to call upload().
 */
export interface B2Engine {
  /** Upload a new session from scratch. */
  upload: UploadEngine["upload"];
  /** Resume a persisted session (crash recovery or explicit pause). */
  resumeSession: UploadEngine["resumeSession"];
  /** Pause an active in-process upload. */
  pause: UploadEngine["pause"];
  /** Resume an in-process paused scheduler (use resumeSession for crash recovery). */
  resumeScheduler: UploadEngine["resumeScheduler"];
  /** Cancel and abort a session (in-flight or persisted). */
  cancel: UploadEngine["cancel"];
  /** Get the current persisted state of a session. */
  getSession: UploadEngine["getSession"];
  /** Public event bus — subscribe here for progress, lifecycle events. */
  bus: EventBus;
  /** The resolved config (with defaults filled in). */
  config: EngineConfig;
  /** The session store being used. */
  store: ISessionStore;
}

/**
 * Create a fully-wired UploadEngine configured for Backblaze B2.
 *
 * This is the recommended starting point for new integrations.
 * For custom adapters, instantiate UploadEngine directly from @transferx/core.
 */
export function createB2Engine(opts: CreateB2EngineOptions): B2Engine {
  const config = resolveEngineConfig(opts.config ?? {});
  const bus = new EventBus();
  const store = opts.store ?? new MemorySessionStore();
  const adapter = new B2Adapter({
    ...opts.b2,
    // Wire adapter-level log events into the shared event bus so consumers
    // see auth-refresh warnings alongside engine-level log events.
    onLog: (level, message, context) =>
      bus.emit(
        context !== undefined
          ? { type: "log", level, message, context }
          : { type: "log", level, message },
      ),
  });

  const engine = new UploadEngine({
    adapter,
    store,
    bus,
    config: opts.config ?? {},
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
