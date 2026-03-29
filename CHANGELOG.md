# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

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
