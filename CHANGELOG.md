# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [0.10.0] — 2025-07-20

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
