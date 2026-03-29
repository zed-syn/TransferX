# TransferX

Enterprise-grade chunked file transfer SDK for Node.js. Built for reliability — retries, resumability, observability, and pluggable storage backends.

```
11 test suites · 152 tests · 0 compile errors
```

---

## Features

- **Chunked multipart upload** — splits files into configurable chunks, uploads them in parallel
- **Retry with full-jitter backoff** — exponential backoff per chunk, rate-limit aware (HTTP 429)
- **Resumable sessions** — sessions are persisted to disk; resume after crash with zero data loss
- **Live progress events** — EMA-smoothed speed, ETA, bytes/s, percent on a typed event bus
- **Pluggable adapters** — Backblaze B2 included; implement `ITransferAdapter` for any provider
- **Strict TypeScript** — `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`
- **Zero runtime dependencies** in `@transferx/core`

---

## Packages

| Package                 | Description                                                    |
| ----------------------- | -------------------------------------------------------------- |
| `@transferx/sdk`        | **Start here.** High-level façade — `createB2Engine()` factory |
| `@transferx/core`       | Engine, scheduler, retry, progress, stores, types              |
| `@transferx/adapter-b2` | Backblaze B2 Native API adapter                                |

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
  // Optional: persist sessions for crash-resume
  store: new FileSessionStore("./.transferx-sessions"),
  config: {
    chunkSize: 10 * 1024 * 1024, // 10 MiB per chunk
    concurrency: { initial: 4, min: 1, max: 16, adaptive: false },
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

// Build session and upload
const stat = fs.statSync("/path/to/video.mp4");
const session = makeUploadSession(
  "upload-01",
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
// result.state === 'done'
```

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

| Field      | Default | Description                        |
| ---------- | ------- | ---------------------------------- |
| `initial`  | `4`     | Starting concurrency               |
| `min`      | `1`     | Minimum (adaptive lower bound)     |
| `max`      | `16`    | Maximum (adaptive upper bound)     |
| `adaptive` | `true`  | Enable adaptive concurrency tuning |

---

## Events

Subscribe via `bus.on(type, handler)`. All events are strongly typed.

| Event               | Payload                                | When                                    |
| ------------------- | -------------------------------------- | --------------------------------------- |
| `session:created`   | `{ session }`                          | Session initialised, before any HTTP    |
| `session:started`   | `{ session }`                          | All chunks queued, uploading begins     |
| `session:paused`    | `{ session }`                          | `engine.pause()` called                 |
| `session:resumed`   | `{ session }`                          | `engine.resume()` called                |
| `session:done`      | `{ session }`                          | All chunks confirmed, transfer complete |
| `session:failed`    | `{ session, error }`                   | Unrecoverable failure                   |
| `session:cancelled` | `{ session }`                          | User cancelled                          |
| `chunk:started`     | `{ session, chunk }`                   | Chunk upload begins                     |
| `chunk:done`        | `{ session, chunk }`                   | Chunk confirmed by provider             |
| `chunk:failed`      | `{ session, chunk, error, willRetry }` | Attempt failed, may retry               |
| `chunk:fatal`       | `{ session, chunk, error }`            | Chunk exhausted retry budget            |
| `progress`          | `{ progress }`                         | Throttled progress snapshot             |

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
                                    ├──→ paused → running
                                    │
                                    └──→ failed → queued (retry)
                                    │
                                    └──→ cancelled
```

Sessions in `done` and `cancelled` are **terminal** — no further transitions.

---

## Error Taxonomy

| Category      | Retryable | Cause                             |
| ------------- | --------- | --------------------------------- |
| `network`     | ✅        | Connection reset, timeout         |
| `rateLimit`   | ✅        | HTTP 429 — respects `Retry-After` |
| `serverError` | ✅        | HTTP 5xx                          |
| `checksum`    | ✅        | Local integrity check failed      |
| `unknown`     | ✅        | Conservative — retried by default |
| `clientError` | ❌        | HTTP 4xx (except 429) — our bug   |
| `auth`        | ❌        | 401/403 — needs token refresh     |
| `cancelled`   | ❌        | User-initiated                    |
| `fatal`       | ❌        | Unrecoverable state               |

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
// On restart, load and resume:
const sessions = await store.listAll();
for (const s of sessions) {
  if (s.state === "failed" || s.state === "paused") {
    await engine.upload(s); // resumes from last known good state
  }
}
```

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   @transferx/sdk                    │
│  createB2Engine()  ·  makeUploadSession()           │
└───────────────────────┬─────────────────────────────┘
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
│         B2Adapter  ·  (your adapter here)           │
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

| Suite                  | Tests | Coverage                           |
| ---------------------- | ----- | ---------------------------------- |
| `chunk.test.ts`        | 8     | ChunkMeta invariants               |
| `session.test.ts`      | 37    | State machine, transitions         |
| `chunker.test.ts`      | 14    | File splitting edge cases          |
| `scheduler.test.ts`    | 11    | Concurrency, pause/resume, drain   |
| `retry.test.ts`        | 11    | Backoff, non-retryable fast-fail   |
| `progress.test.ts`     | 13    | EMA speed, ETA, interval emission  |
| `store.memory.test.ts` | 14    | CRUD, deep-clone isolation         |
| `store.file.test.ts`   | 12    | Atomic writes, corruption guard    |
| `eventbus.test.ts`     | 16    | on/off/emit/clear, dispatch safety |
| `engine.test.ts`       | 34    | Full upload lifecycle              |
| `B2Adapter.test.ts`    | 15    | Mock-fetch B2 lifecycle            |

**Total: 152 tests**

---

## Project Structure

```
packages/
  core/          – @transferx/core  (engine + all primitives)
  sdk/           – @transferx/sdk   (public entry point)
  adapters/
    b2/          – @transferx/adapter-b2
    http/        – @transferx/adapter-http  (planned)
examples/
  node-b2/       – Production-ready CLI upload example
docs/
  index.html     – Full API documentation
```

---

## License

MIT
