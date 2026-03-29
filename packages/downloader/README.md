# @transferx/downloader

IDM-class parallel HTTP download engine for Node.js. Supports multi-connection
range downloads, byte-level crash resume, per-chunk retry with exponential
back-off, EMA-smoothed progress events, and graceful fallback to single-stream
for servers that do not support `Range` requests.

---

## Features

| Feature              | Details                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------- |
| Parallel connections | Up to 8 simultaneous range requests (configurable)                                            |
| Crash resume         | JSON session persisted to disk; resumes from the last complete chunk boundary                 |
| Retry                | Per-chunk exponential back-off with full jitter; non-retryable errors (4xx) throw immediately |
| Progress             | EMA-smoothed `bytesPerSec`, `percent`, `eta`, throttled to 250 ms intervals                   |
| Adaptive concurrency | Sliding-window error-rate controller raises/lowers the connection ceiling automatically       |
| Server fallback      | If the server returns `200` instead of `206`, falls back to a single-stream download          |
| Stale detection      | Detects stale sessions via ETag → Last-Modified → file-size comparison before resuming        |
| No native deps       | Pure Node.js; only `node:fs`, `node:crypto`, `node:path`                                      |

---

## Installation

`@transferx/downloader` is re-exported by `@transferx/sdk`, so in most cases
you only need to install the SDK:

```bash
npm install @transferx/sdk
```

For direct use without the SDK:

```bash
npm install @transferx/downloader
```

---

## Quick Start

### Using the SDK (recommended)

```typescript
import { createDownloader } from "@transferx/sdk";

const task = createDownloader({
  url: "https://example.com/large-file.zip",
  outputPath: "/tmp/large-file.zip",
});

task.on("progress", (p) => {
  console.log(
    `${p.percent?.toFixed(1) ?? "?"}%  ${(p.speedBytesPerSec / 1024 / 1024).toFixed(1)} MB/s`,
  );
});

task.on("log", ({ level, message }) => {
  if (level !== "debug") console.log(`[${level}] ${message}`);
});

await task.start();
console.log("Done!");
```

### Using the package directly

```typescript
import { DownloadEngine, DownloadTask } from "@transferx/downloader";

const engine = new DownloadEngine(); // uses defaults

const raw = engine.createTask("https://example.com/file.zip", "/tmp/file.zip");
const task = new DownloadTask(raw);

task.on("progress", (p) => console.log(p));
await task.start();
```

---

## Pause / Resume / Cancel

```typescript
const task = createDownloader({ url, outputPath });

task.on("progress", (p) => console.log(p));

const done = task.start(); // returns a Promise<DownloadSession>

// Pause download (in-flight chunks continue until they finish naturally)
task.pause();

// Resume
task.resume();

// Cancel — writes a "cancelled" session to disk so the download can be resumed
// later in a new process.
await task.cancel();

// On next launch, call task.start() again — it will detect the saved session,
// re-validate the server ETag/Last-Modified, and re-download only the chunks
// that were incomplete at cancellation time.
```

---

## Crash Resume

Session data is stored as JSON in `<storeDir>/<sessionId>.json` where:

- `storeDir` defaults to `~/.transferx/sessions`
- `sessionId` is derived as `sha256(url + "\0" + outputPath).slice(0, 16)` (hex)

On the next call to `task.start()` for the same `url` / `outputPath` pair:

1. The session file is loaded and staleness is checked against the server
   (ETag → Last-Modified → Content-Length, in order of preference).
2. If the server resource has changed, a `staleSession` error is thrown.
3. Otherwise, only chunks with status `pending` or `failed` are re-downloaded.

**Limitation**: Resume granularity is per-chunk. If a chunk was partially
written before a crash, the entire chunk is re-downloaded from its start offset.

---

## Configuration

```typescript
const engine = new DownloadEngine({
  config: {
    concurrency: 4, // parallel connections (default: 8)
    chunkSizeBytes: 8 << 20, // 8 MiB chunk size (default: 4 MiB)
    retry: {
      maxAttempts: 5, // max retry attempts per chunk (default: 5)
      baseDelayMs: 500, // initial backoff base (default: 500 ms)
      maxDelayMs: 30_000, // backoff ceiling (default: 30 s)
      jitterMs: 200, // random jitter added to each delay (default: 200 ms)
    },
    progressIntervalMs: 500, // progress event throttle (default: 250 ms)
    headers: {
      // extra headers sent on every request
      Authorization: "Bearer <token>",
    },
  },
  storeDir: "/var/lib/myapp/dl-sessions", // custom session store path
});
```

All config fields are optional; unset fields use the defaults shown above.

---

## Events

| Event       | Payload                        | Notes                                                                                     |
| ----------- | ------------------------------ | ----------------------------------------------------------------------------------------- |
| `progress`  | `DownloadProgress`             | Throttled (default 250 ms). `percent` and `eta` are `null` when Content-Length is unknown |
| `completed` | `DownloadSession`              | Fired once when all chunks finish                                                         |
| `error`     | `DownloadError`                | Fired on fatal failure (after all retries exhausted)                                      |
| `log`       | `{ level, message, context? }` | Structured log events (info / warn / debug / error)                                       |

### `DownloadProgress`

```typescript
interface DownloadProgress {
  sessionId: string;
  bytesDownloaded: number; // bytes written so far
  totalBytes: number | null; // null if server did not send Content-Length
  percent: number | null; // 0–100, null when totalBytes is null
  speedBytesPerSec: number; // EMA-smoothed; 0 when stalled or finished
  eta: number | null; // remaining seconds, null when unknown
  chunksTotal: number;
  chunksDone: number;
  chunksFailed: number;
}
```

---

## Error Handling

All thrown errors are `DownloadError` instances:

```typescript
import type { DownloadError, ErrorCategory } from "@transferx/downloader";

task.on("error", (err: DownloadError) => {
  switch (err.category) {
    case "network":
      /* DNS / TCP failure */ break;
    case "timeout":
      /* request timed out */ break;
    case "serverError":
      /* 5xx (after retries) */ break;
    case "clientError":
      /* 4xx (not retried) */ break;
    case "rangeError":
      /* 416 Range Not Satisfiable */ break;
    case "auth":
      /* 401/403 */ break;
    case "notFound":
      /* 404 */ break;
    case "disk":
      /* I/O failure */ break;
    case "staleSession":
      /* server resource changed */ break;
    case "unknown":
      /* unexpected error */ break;
  }
});
```

`DownloadError` has `chunkIndex?: number` (which chunk failed) and
`statusCode?: number` (HTTP status, when available).

---

## Architecture

```
createDownloader(url, outputPath, opts)
  └─ DownloadEngine.createTask() → DownloadEngineTask
       └─ DownloadTask (public API)

DownloadEngine.run(task):
  1. CapabilityDetector.detect(url)     — HEAD request; discovers range support,
                                          Content-Length, ETag, Last-Modified
  2. ResumeStore.load(sessionId)        — load prior session (if any)
     └─ detectStaleness()              — compare ETag/LM/size with server
     └─ RangePlanner.rehydrate()       — reset in-progress chunk state
  3. RangePlanner.plan()               — split fileSize into N equal chunks
                                          (or single streaming chunk if no range)
  4. FileWriter.open()                  — open/create output file
  5. ProgressEngine.start()            — start EMA speed timer
  6. ChunkScheduler.push() × N         — enqueue chunk tasks
     └─ per chunk:
          withRetry(_downloadChunk)    — fetch Range bytes, stream to FileWriter
        → recordSuccess/recordFailure  — feed adaptive concurrency controller
  7. ChunkScheduler.drain()            — wait for all chunks to finish
  8. FileWriter.flush() + close()      — fsync + cleanup
  9. ResumeStore.delete(sessionId)     — remove session file on success

On cancel:  session persisted as "cancelled" (resumable)
On failure: session persisted as "failed" with per-chunk error details
```

---

## TypeScript

The package ships with full TypeScript declarations. All public types are
exported from the package root:

```typescript
import type {
  DownloadConfig,
  DownloadSession,
  DownloadProgress,
  DownloadError,
  ErrorCategory,
  ChunkMeta,
} from "@transferx/downloader";
```

Requires TypeScript ≥ 4.9 and Node.js ≥ 18.

---

## License

MIT
