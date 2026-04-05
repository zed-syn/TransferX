# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [1.3.0] — 2026-04-01

### Added — `@transferx/downloader`

- **Connection pooling via undici** (`HttpClient.ts`): new `IHttpClient` abstraction
  with `FetchHttpClient` (test/fallback path) and `PooledHttpClient` (production, uses
  `undici.Pool`). A single pool is created per download task and shared across all
  parallel chunk requests, eliminating per-chunk TCP/TLS handshake overhead.
- **`PooledHttpClient`** keeps sockets alive between chunks with `pipelining: 1` and
  `keepAliveTimeout: 4 000 ms`, matching IDM-class behavior on HTTP/1.1 servers.
- **`createHttpClient()` factory**: auto-selects `PooledHttpClient` when undici is
  installed; gracefully falls back to `FetchHttpClient(globalThis.fetch)` when it is
  not — no breaking change to existing code paths.
- **HTTP pool stats log event**: `DownloadEngine` emits `"HTTP pool stats: {…}"` on
  the `log` bus channel after each task completes, reporting `requests`, `reuseRate`,
  `pooled`, and pool `origin`.
- **New exports** (`IHttpClient`, `IHttpResponse`, `IHttpRequestOptions`,
  `ConnectionStats`, `FetchHttpClient`, `PooledHttpClient`, `createHttpClient`,
  `isUndiciAvailable`) added to both `@transferx/downloader` and `@transferx/sdk`.
- **`undici ^6.21.0`** added as a peer/optional dependency of `@transferx/downloader`.

### Changed — `@transferx/downloader`

- `DownloadEngine._downloadChunk` now accepts an `IHttpClient` parameter instead of a
  raw `fetchFn`. All callers are internal; no public API change.

---

## [1.2.0] — 2026-03-30

### Added — `@transferx/downloader`

- **Byte-level sub-chunk resume** (`DownloadEngine`): on retry the engine reads
  `chunk.bytesWritten` and rounds it down to the nearest 1 MiB boundary
  (`RESUME_GRANULARITY`). The `Range` header and write-offset are both adjusted
  so only the un-confirmed bytes are re-downloaded. Idempotent pwrite semantics
  make the overlap safe.
- **True pre-allocation** (`FileWriter`): replaced the single-byte stamp with
  `fs.ftruncate(fd, fileSize)` so the full file extent is reserved immediately
  after open, eliminating fragmentation on most file-systems.
- **Per-chunk fdatasync** (`FileWriter.syncOnChunkComplete`): new method that
  flushes the kernel write-back cache every N completed chunks, bounding
  power-loss data loss to `fsyncIntervalChunks × chunkSize`. Default N = 8.
- **Write-coalescing buffer pool** (`BufferPool`): free-list of up to 64 ×
  256 KiB buffers. `FileWriter.writeStream` accepts an optional `BufferPool`
  and accumulates small stream frames into a single large write, reducing GC
  pressure and syscall count.
- **Throughput-aware concurrency** (`ChunkScheduler.addThroughputSample`):
  scale-up is now gated on a ≥5 % improvement in the 10-sample rolling median
  throughput versus the level at the last scale-up. Error-rate scale-down
  remains unchanged.
- **`DownloadManager`**: FIFO queue with `maxConcurrentDownloads` cap (default
  3). API: `enqueue`, `cancelAll`, `pauseAll`, `resumeAll`, `getStatus`.
  Exposes `ManagedDownload`, `DownloadManagerOptions`, `DownloadManagerStatus`
  types.
- **`DownloadMetrics`**: passive event-driven metrics collector mirroring the
  upload `MetricsEngine`. Tracks `bytesDownloaded`, `chunksCompleted`,
  `chunksFailed`, `retryCount`, `errorRate`, `avgChunkLatencyMs`,
  `peakSpeedBytesPerSec`, `currentSpeedBytesPerSec`. API: `attach`, `detach`,
  `getSnapshot`, `getAllSnapshots`, `getAggregate`, `reset`.
- **`fsyncIntervalChunks`** field added to `DownloadConfig` (default 8).

### Fixed — `@transferx/downloader`

- **`RangePlanner.rehydrate`**: previously reset `bytesWritten` to 0 for every
  `pending` / `failed` chunk, discarding partial write progress. Now preserves
  `bytesWritten` so the byte-level resume path gets correct data.

### Added — `@transferx/sdk`

- Re-exports `DownloadManager`, `DownloadMetrics` and all associated types so
  SDK consumers get the full download feature set without importing the
  lower-level package directly.

### Tests

- 17 new tests added across 6 new suites: byte-level sub-chunk resume, FileWriter
  pre-allocation / fdatasync, DownloadManager, DownloadMetrics, ChunkScheduler
  throughput signal. Total test count: 302 (up from 285).

---

## [1.1.0] — 2026-03-29

### Fixed (Phase 0 — Audit Blockers)

- **P0 — Adaptive concurrency signal was wrong** (`UploadEngine`):
  `scheduler.recordFailure()` was only called when a chunk exhausted its retry
  budget (fatal). Under the new behaviour it is called on **every** retryable
  failure attempt, meaning the adaptive algorithm now sees the full error rate
  instead of ~1/maxAttempts of it. Without this fix, the scheduler was ~5× too
  slow to react to network degradation.

- **P0 — `ResumeStore.load()` caught all errors** (`@transferx/downloader`):
  The bare `catch {}` blocks inside `load()` silently swallowed permission
  errors, disk errors, and other unexpected exceptions — potentially returning
  stale `.tmp` data when the real error was unrelated to a missing file.
  Fixed to re-throw any error that is neither ENOENT nor a `SyntaxError`
  (JSON corruption), matching the pattern established by `FileSessionStore`.

- **P0 — `createHttpEngine()` missing from SDK** (`@transferx/sdk`):
  The README documented this factory but the implementation was absent.
  Added `createHttpEngine(opts: CreateHttpEngineOptions): EngineHandle` matching
  the existing `createB2Engine` / `createS3Engine` / `createR2Engine` pattern.

- **P0 — Config layer lacked input validation** (`@transferx/core`):
  `resolveEngineConfig()` now throws `RangeError` for invalid values:
  `chunkSize < 1`, `concurrency.initial < 1`, `concurrency.min < 1`, and
  `retry.maxAttempts < 1`. Adapter-specific minimums (e.g. B2/S3's 5 MiB
  part floor) are still enforced inside each adapter's `initTransfer()` so
  that test code can use small chunk sizes safely.

- **P0 — `HttpAdapter.getRemoteState` was always present** (`@transferx/adapter-http`):
  Even when `getRemoteStateFn` was not provided, the method existed on the
  instance and threw on every resume attempt. The engine's guard
  `if (!this._adapter.getRemoteState)` therefore always evaluated to false,
  forcing every resume through an exception path. Fixed: `getRemoteState` is
  now conditionally assigned in the constructor — only present when
  `getRemoteStateFn` is configured.

- **P0 — `"log" as any` type casts in `DownloadEngine`** (`@transferx/downloader`):
  Three `this.bus.emit("log" as any, …)` calls bypassed the `DownloadEventBus`
  type safety. Fixed by adding `log` to `DownloadEventMap`:
  `{ taskId, level, message }`. The `as any` casts are removed.

### Added (Phase 1 — Reliability)

- **`TransferManager`** (`@transferx/core`) — global coordinator for multiple
  concurrent upload sessions:
  - `maxConcurrentUploads` cap (default: 4) with FIFO back-pressure queuing.
  - `enqueue(session)` — start or queue an upload; returns Promise resolving to
    the final `TransferSession`.
  - `enqueueResume(sessionId)` — resume a persisted session with same queuing logic.
  - `pauseAll()` / `resumeAll()` — synchronously pause/resume all active sessions.
  - `cancelAll()` — rejects all queued promises and cancels all active sessions.
  - `cancel(sessionId)` — cancel a single queued or active session by ID.
  - `getStatus()` — lightweight snapshot: `activeUploads`, `queuedUploads`,
    `maxConcurrentUploads`. No I/O.

### Added (Phase 2 — Observability)

- **`MetricsEngine`** (`@transferx/core`) — passive event-driven metrics collector:
  - `attach(bus)` — subscribe to an `EventBus`; no instrumentation in hot path.
  - `getSnapshot(sessionId)` — per-session `MetricsSnapshot`:
    `bytesTransferred`, `chunksStarted`, `chunksCompleted`, `chunksFailed`,
    `chunksFatal`, `retryCount`, `errorRate`, `avgChunkLatencyMs`,
    `peakSpeedBytesPerSec`, `capturedAt`.
  - `getAllSnapshots()` — all tracked sessions.
  - `getAggregate()` — global aggregate across all sessions; includes
    `sessionCount` and weighted `avgChunkLatencyMs`.
  - `reset(sessionId?)` — clear specific or all sessions.
  - `detach()` — unsubscribe all event listeners.

### Added (Phase 3 — Performance)

- **`recommendChunkSize(fileSizeBytes)`** (`@transferx/core`) — utility that
  returns an optimal chunk size based on file size, balancing part count against
  retry cost. Follows B2/S3 5 MiB minimum:

  | File size     | Recommended chunk |
  | ------------- | ----------------- |
  | < 100 MiB     | 5 MiB             |
  | 100 MiB–1 GiB | 10 MiB            |
  | 1 GiB–10 GiB  | 25 MiB            |
  | ≥ 10 GiB      | 50 MiB            |

### Added (Phase 4 — Ecosystem)

- **`HttpAdapter` / `createHttpAdapter`** now exported from `@transferx/sdk`.
- **`HttpAdapterOptions`** type now exported from `@transferx/sdk`.
- `createHttpEngine()` factory in SDK (see Phase 0 fix above).

### Tests

- Added 16 new tests (285 total across 17 suites):
  - `transfermanager.test.ts` ×6: single upload, status counters, queuing order,
    cancelAll, cancel-by-ID, concurrent-within-cap.
  - `metrics.test.ts` ×10: attach/detach, byte tracking, fatal tracking, retry
    counting, getAllSnapshots, getAggregate, reset (session + global), empty aggregate.
- Updated `HttpAdapter.test.ts`: replaced "throws on missing getRemoteStateFn"
  with "is undefined when not provided" and "is defined when provided" tests
  to match the new conditional-assignment behaviour.

---

## [1.0.0] — 2026-01-15

### Added

- **`@transferx/adapter-http`** — generic callback-based adapter for custom
  HTTP multipart endpoints. Does zero network I/O itself; all transport concerns
  are delegated to caller-supplied `initFn`, `uploadFn`, `completeFn`,
  `abortFn?`, and optional `getRemoteStateFn?`.
- **`createHttpAdapter(opts)`** factory in `@transferx/adapter-http`.

### Changed

- **Adaptive concurrency is now fully implemented.** `ConcurrencyPolicy.adaptive`
  (default: `true`) enables a sliding-window error-rate algorithm:
  `errorRate > 30%` → scale down (floor: `min`);
  `errorRate < 5%` for 10+ consecutive successes → scale up (ceiling: `max`).
  All "NOT YET IMPLEMENTED" notices removed from the JSDoc.

- All packages bumped to version **1.0.0** (first stable release).

### Tests

- Added 22 new tests (266 total, 15 suites):
  - `scheduler.test.ts` +8: adaptive algorithm (plain number, scale-down,
    min floor, scale-up, max ceiling, adaptive:false, cooldown, steady state).
  - `HttpAdapter.test.ts` ×14: full lifecycle coverage.

---

### Added

- **`@transferx/downloader`** — new package providing an IDM-class parallel
  HTTP download engine:
  - Multi-connection range downloads with configurable concurrency (default: 8).
  - Byte-level crash resume via a persistent JSON session store; session ID is
    derived as `sha256(url + "\0" + outputPath).slice(0, 16)`.
  - Server stale-detection before resuming: ETag → Last-Modified → file-size,
    in order of preference.
  - Per-chunk retry with truncated binary exponential back-off and full jitter;
    non-retryable errors (4xx) throw immediately without consuming retry budget.
  - EMA-smoothed `speedBytesPerSec`, `percent`, and `eta` via `ProgressEngine`
    (alpha = 0.2, throttled to 250 ms intervals).
  - Adaptive concurrency controller: sliding-window error-rate measurement
    automatically lowers the connection ceiling under load and raises it when
    the error rate recovers.
  - Graceful single-stream fallback for servers that do not support `Range`
    requests; resume is unavailable in this mode but progress still emits.
  - `CapabilityDetector` — HEAD-based server feature discovery (range support,
    Content-Length, ETag, Last-Modified).
  - `RangePlanner` — splits file size into equal chunks; `end: -1` sentinel
    for streaming (unknown-size) chunks; `rehydrate()` resets in-progress
    chunk state for safe resume.
  - `FileWriter` — pwrite-based streaming writes at precise byte offsets;
    `'w'` flag on fresh open (prevents stale trailing bytes); `'r+'` flag on
    resume (preserves existing bytes).
  - `ResumeStore` — atomic JSON session persistence with per-chunk status
    tracking, cancellation support, and error serialization.
  - `DownloadTask` — public API: `start()`, `pause()`, `resume()`,
    `cancel()`, typed event emitter (`progress`, `completed`, `error`, `log`).
  - `createDownloadTask()` / `createDownloader()` — convenience factories.

- **`@transferx/sdk`** re-exports all `@transferx/downloader` public types and
  the `createDownloader()` factory.

### Fixed

- `FileWriter`: replaced inline `require("path")` with a proper
  `import * as path from "path"` at the module level.
- `RangePlanner.rehydrate()`: now correctly resets `bytesWritten` for chunks
  with status `"failed"` as well as `"running"`.
- `RangePlanner.plan()`: single-stream fallback chunk now uses `end: -1`
  sentinel instead of the previously invalid `end: 0`.

### Tests

- Added 29 new tests (244 total across 14 suites):
  - `downloader.test.ts` ×29: RangePlanner (5), FileWriter (3), RetryEngine (6),
    ProgressEngine (3), ChunkScheduler (4), DownloadEngine integration (8).

---

## [0.9.0] — 2025-07-16

### Fixed

- **P0** `B2Adapter`: auth token expiry no longer permanently fails long-running
  uploads. `uploadChunk()` now transparently re-authorizes once on `401` and
  retries the part before propagating an `authError`.

- **P0** `EventBus`: handler errors no longer propagate into the engine. Every
  handler is wrapped in `try/catch`; uncaught errors are re-emitted as
  `log:error` events so the engine continues unaffected.

- **P0** `B2Adapter`: all HTTP requests now have a configurable timeout
  (default 120 s) via `AbortController`. Previously a stalled connection would
  hang indefinitely.

- **P1** `checksumVerify: false` now correctly skips SHA-256 computation.
  Previously SHA-256 was always computed regardless of the config flag.

- **P1** ESM compatibility: replaced the implicit CommonJS `require()` inside
  `UploadEngine` with `createRequire(__filename)` so the engine can be bundled
  in ESM contexts without errors.

### Added

- `B2AdapterOptions.timeoutMs` (`number`, default `120000`) — configures the
  per-request HTTP timeout in milliseconds.

- `B2AdapterOptions.onLog` — structured log callback `(level, message,
context?) => void`. `createB2Engine()` automatically wires this to the shared
  event bus so all B2 adapter logs surface as `log` events.

- `UploadEngineOptions.fileStatFn` — optional `(path: string) => Promise<{
mtimeMs: number }>`. When provided, `resumeSession()` throws `fileChangedError`
  if the file's modification time differs from the value stored in the session
  at creation time.

- `FileDescriptor.mtimeMs?: number` — store the file's mtime at session-creation
  time to enable crash-resume file-change detection.

- `log` events from the engine:
  - `log:warn` on every retryable chunk failure (before backoff delay)
  - `log:info` after reconcile completes in `resumeSession()`
  - `log:info` when a session reaches the `done` state

- `log:warn` from `B2Adapter` when an auth token has expired and a transparent
  re-authorization is triggered.

### Changed

- **BREAKING** `TransferDirection` is now `"upload"` only. The `"download"`
  variant was removed — no download implementation existed and its presence was
  misleading.

- `ConcurrencyPolicy.adaptive`, `.min`, and `.max` are now documented as **NOT
  YET IMPLEMENTED**. These fields are accepted and stored in the session, but
  they have no effect at runtime. The effective concurrency is always `initial`.

### Tests

- Added 17 new tests (185 total across 12 suites):
  - `B2Adapter.test.ts` +3: transparent re-auth success/failure, HTTP timeout
  - `eventbus.test.ts` +4: handler error isolation, log event on throw, no recursion
  - `engine.test.ts` +6: `checksumVerify: false/true`, EventBus isolation e2e, log events
  - `resume.test.ts` +4: file-change detection (mtime differs/matches/skipped/log)
