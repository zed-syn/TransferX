# TransferX

![npm](https://img.shields.io/npm/v/@transferx/sdk)
![license](https://img.shields.io/github/license/zed-syn/TransferX)
![tests](https://img.shields.io/badge/tests-302_passed-brightgreen)

Enterprise-grade chunked file transfer SDK for Node.js. Built for reliability — retries, resumability, observability, and pluggable storage backends.

```
17 test suites · 302 tests · 0 compile errors
```

---

## Features

- **Chunked multipart upload** — splits files into configurable chunks, uploads them in parallel
- **Parallel HTTP downloads** — IDM-class range downloads, adaptive concurrency, true byte-level sub-chunk crash resume
- **Retry with full-jitter backoff** — exponential backoff per chunk, rate-limit aware (HTTP 429)
- **Resumable sessions** — sessions persisted to disk; resumes from sub-chunk byte boundary, not just chunk boundary
- **Live progress events** — EMA-smoothed speed, ETA, bytes/s, percent on a typed event bus
- **Pluggable adapters** — B2, S3/R2, and generic HTTP adapters included; implement `ITransferAdapter` for any provider
- **Adaptive concurrency** — throughput hill-climbing + error-rate controller scales parallel connections between `min` and `max`
- **DownloadManager** — global FIFO queue with `maxConcurrentDownloads` cap; prevents resource exhaustion across concurrent downloads
- **DownloadMetrics** — passive event-driven metrics: bytes, chunk latency, retry count, error rate, peak speed per task
- **Strict TypeScript** — `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`
- **Zero runtime dependencies** in `@transferx/core`

---

## Packages

| Package                   | Description                                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `@transferx/sdk`          | **Start here.** High-level façade — `createB2Engine()`, `createS3Engine()`, `createR2Engine()`, `createHttpEngine()`, `createDownloader()` |
| `@transferx/core`         | Engine, scheduler, retry, progress, stores, types                                                                                          |
| `@transferx/adapter-b2`   | Backblaze B2 Native API adapter                                                                                                            |
| `@transferx/adapter-s3`   | AWS S3 and Cloudflare R2 multipart upload adapter                                                                                          |
| `@transferx/adapter-http` | Generic callback-based HTTP adapter — works with any custom multipart endpoint                                                             |
| `@transferx/downloader`   | IDM-class parallel HTTP download engine with crash resume                                                                                  |

---

## Quick Start

### 1. Install

```bash
npm install @transferx/sdk
```

### 2. Upload a file to Backblaze B2

```typescript
import * as fs from "fs";
import {
  createB2Engine,
  makeUploadSession,
  FileSessionStore,
} from "@transferx/sdk";

const { upload, bus, config, store } = createB2Engine({
  b2: {
    applicationKeyId: process.env.B2_APPLICATION_KEY_ID!,
    applicationKey: process.env.B2_APP_KEY!,
    bucketId: process.env.B2_BUCKET_ID!,
  },
  store: new FileSessionStore("./.transferx-sessions"),
  config: {
    chunkSize: 10 * 1024 * 1024, // 10 MiB per chunk
    concurrency: { initial: 4, min: 1, max: 16, adaptive: true },
  },
});

// Subscribe to live progress
bus.on("progress", ({ progress }) => {
  process.stdout.write(
    `\r${progress.percent.toFixed(1)}%  ${(progress.speedBytesPerSec / 1e6).toFixed(2)} MB/s`,
  );
});

bus.on("session:done", ({ session }) => console.log("\nDone!", session.id));
bus.on("session:failed", ({ session, error }) =>
  console.error("\nFailed:", error.message),
);

// Build session — makeSessionId() derives a stable crash-safe ID from path+key+size
const stat = fs.statSync("/path/to/video.mp4");
const session = makeUploadSession(
  makeSessionId("/path/to/video.mp4", "uploads/2024/video.mp4", stat.size),
  {
    name: "video.mp4",
    size: stat.size,
    mimeType: "video/mp4",
    path: "/path/to/video.mp4",
  },
  "uploads/2024/video.mp4",
  config,
);

await store.save(session);
const result = await upload(session);
if (result.state !== "done") {
  throw new Error(
    `Upload ended in state "${result.state}" — check session:failed event for details`,
  );
}
```

### 3. Upload to AWS S3

```bash
npm install @transferx/adapter-s3
```

```typescript
import * as fs from "fs";
import {
  createS3Engine,
  makeUploadSession,
  FileSessionStore,
} from "@transferx/sdk";

const { upload, bus, config, store } = createS3Engine({
  s3: {
    bucket: process.env.S3_BUCKET!,
    region: "us-east-1",
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  },
  store: new FileSessionStore("./.transferx-sessions"),
});

bus.on("session:done", ({ session }) => console.log("\nDone!", session.id));
bus.on("session:failed", ({ session, error }) =>
  console.error("\nFailed:", error.message),
);

const stat = fs.statSync("./video.mp4");
const session = makeUploadSession(
  "s3-upload-001",
  {
    name: "video.mp4",
    size: stat.size,
    mimeType: "video/mp4",
    path: "./video.mp4",
  },
  "uploads/video.mp4",
  config,
);

await store.save(session);
const result = await upload(session);
if (result.state !== "done") {
  throw new Error(`Upload ended in state "${result.state}"`);
}
```

### 4. Upload to Cloudflare R2

```typescript
import * as fs from "fs";
import {
  createR2Engine,
  makeUploadSession,
  FileSessionStore,
} from "@transferx/sdk";

const { upload, bus, config, store } = createR2Engine({
  r2: {
    accountId: process.env.CF_ACCOUNT_ID!,
    bucket: process.env.R2_BUCKET!,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  },
  store: new FileSessionStore("./.transferx-sessions"),
});

const stat = fs.statSync("./video.mp4");
const session = makeUploadSession(
  "r2-upload-001",
  {
    name: "video.mp4",
    size: stat.size,
    mimeType: "video/mp4",
    path: "./video.mp4",
  },
  "uploads/video.mp4",
  config,
);

await store.save(session);
const result = await upload(session);
if (result.state !== "done") {
  throw new Error(`Upload ended in state "${result.state}"`);
}
```

> `createR2Engine()` automatically sets `endpoint`, `region: "auto"`, and `forcePathStyle: true` — no extra config needed.

---

## Configuration

### `EngineConfig`

| Field                | Type                | Default             | Description                                |
| -------------------- | ------------------- | ------------------- | ------------------------------------------ |
| `chunkSize`          | `number`            | `10485760` (10 MiB) | Bytes per chunk. Must be ≥ 5 MiB for B2/S3 |
| `checksumVerify`     | `boolean`           | `true`              | Compute SHA-256 per chunk before upload    |
| `progressIntervalMs` | `number`            | `200`               | How often progress events are emitted (ms) |
| `retry`              | `RetryPolicy`       | see below           | Per-chunk retry configuration              |
| `concurrency`        | `ConcurrencyPolicy` | see below           | Parallel chunk concurrency                 |

### `RetryPolicy`

| Field         | Default | Description                                    |
| ------------- | ------- | ---------------------------------------------- |
| `maxAttempts` | `5`     | Max upload attempts per chunk (includes first) |
| `baseDelayMs` | `500`   | Base delay for exponential backoff             |
| `maxDelayMs`  | `30000` | Maximum backoff cap                            |
| `jitterMs`    | `500`   | Max random jitter added to each delay          |

### `ConcurrencyPolicy`

| Field      | Default | Description                                                                                                |
| ---------- | ------- | ---------------------------------------------------------------------------------------------------------- |
| `initial`  | `4`     | Starting concurrency. When `adaptive` is false this is fixed for the entire upload.                        |
| `min`      | `1`     | Floor — the scheduler will not scale below this value even under sustained high error rates.               |
| `max`      | `16`    | Ceiling — the scheduler will not scale above this value even under sustained low error rates.              |
| `adaptive` | `true`  | Enable adaptive concurrency. Tracks a 20-chunk sliding window; scales down if errorRate > 30%, up if < 5%. |

### `B2AdapterOptions` (via `createB2Engine({ b2: { … } })`)

| Field              | Type       | Default    | Description                                                         |
| ------------------ | ---------- | ---------- | ------------------------------------------------------------------- |
| `applicationKeyId` | `string`   | —          | Backblaze application key ID                                        |
| `applicationKey`   | `string`   | —          | Backblaze application key secret                                    |
| `bucketId`         | `string`   | —          | Target bucket ID                                                    |
| `timeoutMs`        | `number`   | `120000`   | Per-request HTTP timeout in ms. Exceeded requests throw `network`   |
| `onLog`            | `function` | auto-wired | Structured log callback — `createB2Engine()` routes this to the bus |

### Factory options common to all three factories

| Field        | Type                    | Default      | Description                                                                                                                                                                                                                                                                                                       |
| ------------ | ----------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config`     | `Partial<EngineConfig>` | defaults     | Override chunk size, retry policy, concurrency, etc.                                                                                                                                                                                                                                                              |
| `store`      | `ISessionStore`         | **required** | Session persistence store. Use `FileSessionStore` for crash-safe durability across process restarts. `MemorySessionStore` is a valid production choice for Node.js workers that don't need crash recovery between chunks — it is concurrent-safe and avoids file I/O overhead. Sessions are lost on process exit. |
| `fileStatFn` | `function`              | `undefined`  | `(path) => Promise<{ mtimeMs }>`. Enables file-change detection on `resumeSession()`. Throws `fileChangedError` if the file is modified since the session was created.                                                                                                                                            |

---

## Events

Subscribe via `bus.on(type, handler)`. All events are strongly typed.

| Event                 | Payload                                | When                                    |
| --------------------- | -------------------------------------- | --------------------------------------- |
| `session:created`     | `{ session }`                          | Session initialised, before any HTTP    |
| `session:started`     | `{ session }`                          | All chunks queued, uploading begins     |
| `session:paused`      | `{ session }`                          | `engine.pause(id)` called               |
| `session:resumed`     | `{ session }`                          | `engine.resumeScheduler(id)` called     |
| `session:reconciling` | `{ session }`                          | Resume started; verifying remote state  |
| `session:done`        | `{ session }`                          | All chunks confirmed, transfer complete |
| `session:failed`      | `{ session, error }`                   | Unrecoverable failure                   |
| `session:cancelled`   | `{ session }`                          | User cancelled                          |
| `chunk:started`       | `{ session, chunk }`                   | Chunk upload begins                     |
| `chunk:done`          | `{ session, chunk }`                   | Chunk confirmed by provider             |
| `chunk:failed`        | `{ session, chunk, error, willRetry }` | Attempt failed, may retry               |
| `chunk:fatal`         | `{ session, chunk, error }`            | Chunk exhausted retry budget            |
| `progress`            | `{ progress }`                         | Throttled progress snapshot             |
| `log`                 | `{ level, message, context? }`         | Structured log from engine or adapter   |

### `TransferProgress` shape

```typescript
interface TransferProgress {
  sessionId: string;
  percent: number; // 0–100
  transferredBytes: number;
  totalBytes: number;
  speedBytesPerSec: number; // EMA-smoothed
  etaSeconds: number | undefined;
}
```

---

## Session Lifecycle

```
created → initializing → queued → running ──→ done
                                    │
                                    ├──→ paused ──→ reconciling ──→ running
                                    │
                                    ├──→ failed ──→ reconciling ──→ running
                                    │
                                    └──→ cancelled
```

The `reconciling` state is entered when `resumeSession()` is called. The engine
verifies which chunks the provider already has, corrects local state, then
continues from where it left off.

---

## Error Taxonomy

| Category          | Retryable | Cause                                                                           |
| ----------------- | --------- | ------------------------------------------------------------------------------- |
| `network`         | ✅        | Connection reset, timeout                                                       |
| `rateLimit`       | ✅        | HTTP 429 — respects `Retry-After`                                               |
| `serverError`     | ✅        | HTTP 5xx                                                                        |
| `checksum`        | ✅        | Local integrity check failed                                                    |
| `unknown`         | ✅        | Conservative — retried by default                                               |
| `clientError`     | ❌        | HTTP 4xx (except 429) — our bug                                                 |
| `auth`            | ❌        | 401/403 — needs token refresh                                                   |
| `cancelled`       | ❌        | User-initiated                                                                  |
| `duplicateUpload` | ❌        | Upload already active for the same `targetKey` — call `resumeSession()` instead |
| `fatal`           | ❌        | Unrecoverable state                                                             |

---

## Custom Adapter

Implement `ITransferAdapter` from `@transferx/core`:

```typescript
import type {
  ITransferAdapter,
  ChunkUploadResult,
  TransferSession,
  ChunkMeta,
} from "@transferx/core";

export class MyStorageAdapter implements ITransferAdapter {
  async initTransfer(session: TransferSession): Promise<string> {
    // Start a multipart upload on your provider
    // Return the provider's upload session ID
    const { uploadId } = await myStorage.createMultipartUpload(
      session.targetKey,
    );
    return uploadId;
  }

  async uploadChunk(
    session: TransferSession,
    chunk: ChunkMeta,
    data: Uint8Array,
    sha256Hex: string,
  ): Promise<ChunkUploadResult> {
    const etag = await myStorage.uploadPart({
      uploadId: session.providerSessionId!,
      partNumber: chunk.index + 1, // 1-indexed
      data,
      checksum: sha256Hex,
    });
    return { providerToken: etag };
  }

  async completeTransfer(
    session: TransferSession,
    chunks: ChunkMeta[],
  ): Promise<void> {
    await myStorage.completeMultipartUpload({
      uploadId: session.providerSessionId!,
      parts: chunks.map((c) => ({
        partNumber: c.index + 1,
        token: c.providerToken!,
      })),
    });
  }

  async abortTransfer(session: TransferSession): Promise<void> {
    // Best-effort — must never throw
    await myStorage
      .abortMultipartUpload(session.providerSessionId!)
      .catch(() => {});
  }
}
```

Then use it directly with `UploadEngine`:

```typescript
import {
  UploadEngine,
  EventBus,
  MemorySessionStore,
  resolveEngineConfig,
} from "@transferx/core";

const engine = new UploadEngine({
  adapter: new MyStorageAdapter(),
  store: new MemorySessionStore(),
  bus: new EventBus(),
  config: resolveEngineConfig({ chunkSize: 8 * 1024 * 1024 }),
});
```

---

## Session Persistence

For crash-safe uploads use `FileSessionStore`:

```typescript
import { FileSessionStore } from "@transferx/core";

const store = new FileSessionStore("./.transferx-sessions");
// Sessions are written atomically (write-to-tmp then rename)
```

---

## Crash Recovery & Resume

TransferX is designed so that a process crash at any point leaves the session in
a recoverable state. On restart:

```typescript
import {
  createB2Engine,
  FileSessionStore,
  restoreAllSessions,
} from "@transferx/sdk";

const store = new FileSessionStore("./.transferx-sessions");
const engine = createB2Engine({
  b2: {
    /* ... */
  },
  store,
  onCompleted: async (meta) => {
    console.log(`Completed: ${meta.remoteKey} in ${meta.durationMs}ms`);
  },
});

engine.bus.on("session:reconciling", ({ session }) =>
  console.log(`Reconciling ${session.id} with provider…`),
);

// Resume all sessions interrupted by a crash — throttled to 4 concurrent
const { resuming, skipped } = await restoreAllSessions(store, engine, {
  maxConcurrent: 4,
});
console.log(
  `Resuming ${resuming.length} session(s), ${skipped.length} already done.`,
);
```

`resumeSession()` will:

1. Load the session from the store.
2. Query the provider for already-uploaded parts (`getRemoteState`, if the adapter supports it).
3. Mark confirmed parts as done, reset orphaned in-flight parts to pending.
4. Re-upload only the parts that still need uploading.

### Cancel, Pause, and Resume

```typescript
const { upload, resumeSession, pause, resumeScheduler, cancel, store } =
  createB2Engine({
    b2: {
      /* ... */
    },
    store: new FileSessionStore(".sessions"),
  });

// Start an upload
const uploadPromise = upload(session);

// Pause in-process (scheduler stops dispatching new chunks)
pause(session.id);

// Resume in-process scheduler
resumeScheduler(session.id);

// Cancel — stops in-flight and marks cancelled in store
await cancel(session.id);
const result = await uploadPromise; // result.state === 'cancelled'

// Resume after crash or explicit pause
await resumeSession(session.id);
```

---

## makeSessionId()

Generate a deterministic, crash-safe session ID from the upload's inputs:

```typescript
import { makeSessionId } from "@transferx/sdk";

const id = makeSessionId(filePath, targetKey, fileSizeBytes);
// e.g. "a3f2c8e1b0d94f2a67c1" — stable 24-hex SHA-256-based ID
```

`makeSessionId(filePath, targetKey, fileSizeBytes)` hashes `filePath + "|" + targetKey + "|" + fileSizeBytes` with SHA-256, then returns the first 24 hex characters. The same inputs always yield the same ID, which means:

- If a session is saved to the store, a restart with the same file will resolve to the same session ID and `resumeSession()` can pick it up automatically.
- If you accidentally call `upload()` twice with the same arguments, the engine detects the duplicate session and throws `duplicateUploadError` — preventing a double-charge or split file on your storage provider.

---

## onCompleted Callback & CompletedUploadMeta

Rather than parsing raw bus events, supply `onCompleted` to the factory to receive a clean structured payload after every successful upload:

```typescript
const engine = createB2Engine({
  b2: {
    /* ... */
  },
  store: new FileSessionStore(".sessions"),
  onCompleted: async (meta) => {
    // Called once per completed session — errors are caught and emitted as 'log' events
    await db.media.create({
      storageKey: meta.remoteKey,
      fileSizeBytes: meta.fileSizeBytes,
      mimeType: meta.mimeType,
      durationMs: meta.durationMs,
      manifestChecksum: meta.manifestChecksum,
    });
  },
});
```

### `CompletedUploadMeta` shape

| Field              | Type                  | Description                                                                    |
| ------------------ | --------------------- | ------------------------------------------------------------------------------ |
| `sessionId`        | `string`              | Stable session ID                                                              |
| `localPath`        | `string \| undefined` | Absolute local file path (`undefined` in browser context)                      |
| `remoteKey`        | `string`              | Object key on the storage provider                                             |
| `fileSizeBytes`    | `number`              | File size in bytes                                                             |
| `mimeType`         | `string`              | MIME type                                                                      |
| `createdAt`        | `number`              | Epoch ms when the session was first created                                    |
| `completedAt`      | `number`              | Epoch ms when the provider confirmed all parts                                 |
| `durationMs`       | `number`              | `completedAt − createdAt` in milliseconds                                      |
| `chunkCount`       | `number`              | Total parts uploaded                                                           |
| `manifestChecksum` | `string \| undefined` | SHA-256 of sorted per-chunk checksums (`undefined` if `checksumVerify` is off) |
| `session`          | `TransferSession`     | Full session for advanced use                                                  |

### Session completion fields on `TransferSession`

| Field              | Type                  | Description                                                |
| ------------------ | --------------------- | ---------------------------------------------------------- |
| `completingAt`     | `number \| undefined` | Stamped before `completeTransfer()` — crash re-entry guard |
| `completedAt`      | `number \| undefined` | Stamped after provider confirmation                        |
| `manifestChecksum` | `string \| undefined` | Aggregated checksum of all chunk SHA-256s                  |

---

## File Change Detection

When `fileStatFn` is provided to the engine, `resumeSession()` checks whether
the source file has been modified since the session was created, and throws a
`fileChangedError` if so.

Store `mtimeMs` in the session's `FileDescriptor` at creation time:

```typescript
import * as fs from "fs";
import {
  createB2Engine,
  makeUploadSession,
  FileSessionStore,
} from "@transferx/sdk";
import { UploadEngine, EventBus, MemorySessionStore } from "@transferx/core";

const stat = fs.statSync("/path/to/video.mp4");
const session = makeUploadSession(
  "upload-01",
  {
    name: "video.mp4",
    size: stat.size,
    mimeType: "video/mp4",
    path: "/path/to/video.mp4",
    mtimeMs: stat.mtimeMs, // ← store mtime for change detection
  },
  "uploads/2024/video.mp4",
  config,
);
```

Then pass `fileStatFn` when constructing the engine (or use the advanced
`UploadEngine` directly):

```typescript
// Using UploadEngine directly:
const engine = new UploadEngine({
  adapter,
  store,
  bus,
  config: resolveEngineConfig(),
  fileStatFn: (path) => fs.promises.stat(path), // returns { mtimeMs }
});

// On resume, if the file was modified:
try {
  await engine.resumeSession(sessionId);
} catch (err) {
  if (err.category === "fileChanged") {
    console.error("File was modified — please start a new upload session.");
  }
}
```

If `fileStatFn` is not provided the check is skipped and uploads resume as
before.

---

## Observability via Log Events

The engine and B2 adapter emit structured `log` events that can be used for
application logging, monitoring, or debugging without coupling to a logger:

```typescript
bus.on("log", ({ level, message, context }) => {
  // level: "debug" | "info" | "warn" | "error"
  myLogger[level]?.(message, context);
});
```

Log events are emitted for:

| Situation                         | `level` |
| --------------------------------- | ------- |
| Chunk retryable failure (backoff) | `warn`  |
| Reconcile complete on resume      | `info`  |
| Session completed successfully    | `info`  |
| B2 auth token expired, refreshing | `warn`  |
| EventBus handler threw            | `error` |

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   @transferx/sdk                    │
│  createB2Engine()  ·  createS3Engine()              │
│  createR2Engine()  ·  makeUploadSession()           ││  createDownloader()                               │└───────────────────────┬─────────────────────────────┘
                        │
┌───────────────────────▼─────────────────────────────┐
│                  UploadEngine                       │
│  ┌───────────┐  ┌──────────┐  ┌──────────────────┐  │
│  │ Scheduler │  │ Retry    │  │ ProgressEngine   │  │
│  │ (concurr.)│  │ Engine   │  │ (EMA speed/ETA)  │  │
│  └───────────┘  └──────────┘  └──────────────────┘  │
│  ┌───────────┐  ┌──────────┐  ┌──────────────────┐  │
│  │ Chunker   │  │ EventBus │  │ ISessionStore    │  │
│  └───────────┘  └──────────┘  └──────────────────┘  │
└───────────────────────┬─────────────────────────────┘
                        │
┌───────────────────────▼─────────────────────────────┐
│              ITransferAdapter                       │
│   B2Adapter · S3Adapter · R2Adapter · HttpAdapter  │
│   (your adapter here)                              │
└─────────────────────────────────────────────────────┘
```

---

## Development

```bash
# Install dependencies
npm install

# Run all tests
npm test

# Type-check without emitting
npx tsc --noEmit -p tsconfig.base.json

# Run a specific test suite
npx jest --testPathPattern="engine" --runInBand
```

### Test suites

| Suite                  | Tests | Coverage                                                                           |
| ---------------------- | ----- | ---------------------------------------------------------------------------------- |
| `chunk.test.ts`        | 8     | ChunkMeta invariants                                                               |
| `session.test.ts`      | 37    | State machine, transitions                                                         |
| `chunker.test.ts`      | 14    | File splitting edge cases                                                          |
| `scheduler.test.ts`    | 19    | Concurrency, pause/resume, drain, adaptive scale-up/down, cooldown                 |
| `retry.test.ts`        | 11    | Backoff, non-retryable fast-fail                                                   |
| `progress.test.ts`     | 13    | EMA speed, ETA, interval emission                                                  |
| `store.memory.test.ts` | 14    | CRUD, deep-clone isolation                                                         |
| `store.file.test.ts`   | 12    | Atomic writes, corruption guard                                                    |
| `eventbus.test.ts`     | 20    | on/off/emit/clear, dispatch safety, handler isolation                              |
| `engine.test.ts`       | 40    | Full upload lifecycle, checksumVerify, log events                                  |
| `resume.test.ts`       | 21    | Resume, cancel, reconcile, file-change detection                                   |
| `B2Adapter.test.ts`    | 18    | Mock-fetch B2 lifecycle, auth retry, HTTP timeout                                  |
| `S3Adapter.test.ts`    | 30    | S3/R2 lifecycle, resume, error mapping, HTTP timeout                               |
| `HttpAdapter.test.ts`  | 14    | init/upload/complete/abort/getRemoteState, factory, no-op abort, error propagation |
| `downloader.test.ts`   | 29    | RangePlanner, FileWriter, RetryEngine, ProgressEngine, ChunkScheduler, integration |

**Total: 266 tests**

---

## Project Structure

```
packages/
  core/          – @transferx/core  (engine + all primitives)
  sdk/           – @transferx/sdk   (public entry point)
  downloader/    – @transferx/downloader  (parallel HTTP download engine)
  adapters/
    b2/          – @transferx/adapter-b2
    s3/          – @transferx/adapter-s3  (S3 + R2)
    http/        – @transferx/adapter-http  (generic HTTP callback adapter)
examples/
  node-b2/       – Production-ready CLI upload example
docs/
  index.html     – Full API documentation
```

---

## Download a File

### Install

```bash
npm install @transferx/sdk
```

### Download with progress

```typescript
import { createDownloader } from "@transferx/sdk";

const task = createDownloader({
  url: "https://example.com/large-file.zip",
  outputPath: "/tmp/large-file.zip",
});

task.on("progress", (p) => {
  const pct = p.percent?.toFixed(1) ?? "?";
  const mbps = (p.speedBytesPerSec / 1024 / 1024).toFixed(1);
  process.stdout.write(`\r${pct}%  ${mbps} MB/s`);
});

await task.start();
console.log("\nDone!");
```

### Pause / Resume / Cancel

```typescript
const task = createDownloader({ url, outputPath });
const done = task.start();

task.pause();
task.resume();
await task.cancel(); // persists a resumable session to disk

// On next launch with same url + outputPath, start() resumes automatically
```

> See [`packages/downloader/README.md`](packages/downloader/README.md) for the full API reference.

---

## License

MIT
