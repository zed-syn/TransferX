# @transferx/sdk

[![npm](https://img.shields.io/npm/v/@transferx/sdk)](https://www.npmjs.com/package/@transferx/sdk)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/zed-syn/TransferX/blob/main/LICENSE)

> Production-grade chunked upload & download SDK for Node.js — B2, S3, R2, and any custom HTTP endpoint.

**TransferX** is built for large-file transfers (hundreds of GB to multi-TB) where reliability is non-negotiable:

- ♻️ **Chunk-level resume** — crash mid-upload, restart and only the missing parts are re-sent
- 🔁 **Automatic retry** — exponential backoff + full jitter, Retry-After header support
- 💾 **Crash-safe checkpoints** — atomic session files; never lose progress
- ⚡ **Adaptive concurrency** — 1–16 parallel chunks, auto-tuned to network conditions
- 🔒 **SHA-256 integrity** — per-chunk checksum + manifest fingerprint
- 🚦 **Back-pressure** — `TransferManager` ensures at most N files upload simultaneously
- 📥 **IDM-class downloader** — multi-connection range downloads with byte-level resume

📖 **[Full documentation →](https://zed-syn.github.io/TransferX/)**  
🐙 **[GitHub →](https://github.com/zed-syn/TransferX)**

---

## Installation

```bash
npm install @transferx/sdk
```

Requires **Node.js ≥ 18**.

---

## Uploading to Backblaze B2

```typescript
import {
  createB2Engine,
  makeUploadSession,
  makeSessionId,
  FileSessionStore,
} from "@transferx/sdk";
import { statSync } from "fs";

const store = new FileSessionStore("/absolute/path/.transferx-sessions");

const { upload, bus, config } = createB2Engine({
  b2: {
    applicationKeyId: process.env.B2_APPLICATION_KEY_ID!,
    applicationKey: process.env.B2_APP_KEY!,
    bucketId: process.env.B2_BUCKET_ID!,
  },
  store,
  onCompleted: async (meta) => {
    console.log(
      `✓ ${meta.remoteKey} — ${(meta.fileSizeBytes / 1e9).toFixed(2)} GB in ${(meta.durationMs / 1000).toFixed(0)}s`,
    );
    console.log(`  manifest: ${meta.manifestChecksum}`);
    // Create your DB record here:
    // await db.media.create({ storageKey: meta.remoteKey, size: meta.fileSizeBytes, ... });
  },
});

bus.on("session:progress", ({ progress }) => {
  process.stdout.write(
    `\r${progress.percent?.toFixed(1)}%  ${(progress.speedBytesPerSec / 1e6).toFixed(1)} MB/s  ETA ${Math.round((progress.etaMs ?? 0) / 1000)}s`,
  );
});

const filePath = "/data/video.mp4";
const targetKey = "uploads/2026/video.mp4";
const stat = statSync(filePath);

await upload(
  makeUploadSession(
    makeSessionId(filePath, targetKey, stat.size),
    {
      name: "video.mp4",
      size: stat.size,
      mimeType: "video/mp4",
      path: filePath,
    },
    targetKey,
    config,
  ),
);
```

---

## Uploading to AWS S3

```typescript
import {
  createS3Engine,
  makeUploadSession,
  makeSessionId,
  FileSessionStore,
} from "@transferx/sdk";

const { upload, config } = createS3Engine({
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
```

---

## Uploading to Cloudflare R2

```typescript
import {
  createR2Engine,
  makeUploadSession,
  makeSessionId,
  FileSessionStore,
} from "@transferx/sdk";

const { upload, config } = createR2Engine({
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
```

---

## Custom HTTP Endpoint

```typescript
import {
  createHttpEngine,
  makeUploadSession,
  makeSessionId,
  FileSessionStore,
} from "@transferx/sdk";

const { upload, config } = createHttpEngine({
  store: new FileSessionStore("./.transferx-sessions"),
  http: {
    initFn: async (session) => myApi.createUpload(session.targetKey),
    uploadFn: async (session, chunk, data, sha256) =>
      myApi.uploadPart(session.providerSessionId!, chunk.index + 1, data),
    completeFn: async (session, chunks) =>
      myApi.completeUpload(session.providerSessionId!, chunks),
    abortFn: async (session) =>
      myApi.abortUpload(session.providerSessionId!).catch(() => undefined),
  },
});
```

---

## Startup Recovery (crash-safe restarts)

Always call `restoreFromStore()` at startup to resume any uploads interrupted by a crash or restart:

```typescript
import { TransferManager } from "@transferx/sdk";

const manager = new TransferManager({
  adapter,
  store,
  bus,
  maxConcurrentUploads: 4,
});

// On every startup:
const { resuming, skipped } = await manager.restoreFromStore();
console.log(
  `Resuming ${resuming.length} upload(s), skipped ${skipped.length} already done`,
);
```

Or use the standalone helper with an existing engine:

```typescript
import { restoreAllSessions } from "@transferx/sdk";

const { resuming } = await restoreAllSessions(store, engine, {
  maxConcurrent: 4,
});
```

---

## Multiple Concurrent Uploads

```typescript
import { TransferManager } from "@transferx/sdk";

const manager = new TransferManager({
  adapter,
  store,
  bus,
  maxConcurrentUploads: 4, // at most 4 files uploading simultaneously
});

// Enqueue as many as you like — excess are queued FIFO
for (const session of sessions) {
  manager.enqueue(session);
}

// Status (no I/O)
const { activeUploads, queuedUploads } = manager.getStatus();
```

---

## Downloading Files

```typescript
import { createDownloader } from "@transferx/sdk";

const task = createDownloader({
  url: "https://example.com/large-file.zip",
  outputPath: "/downloads/large-file.zip",
  config: { concurrency: { initial: 8 } },
  storeDir: "./.transferx-downloads",
});

task.on("progress", ({ percent, speedBytesPerSec }) => {
  console.log(
    `${percent?.toFixed(1)}%  ${(speedBytesPerSec / 1e6).toFixed(1)} MB/s`,
  );
});
task.on("completed", ({ session }) => {
  console.log("Downloaded to", session.outputPath);
});

await task.start();
```

---

## onCompleted Callback

All four factory functions accept an `onCompleted` callback that fires once per successful upload with a structured metadata payload:

```typescript
onCompleted: async (meta: CompletedUploadMeta) => {
  // meta.sessionId        — stable session ID
  // meta.remoteKey        — object key on the storage provider
  // meta.fileSizeBytes    — total file size
  // meta.mimeType         — MIME type
  // meta.createdAt        — epoch ms when session was created
  // meta.completedAt      — epoch ms when upload completed
  // meta.durationMs       — wall-clock upload duration
  // meta.chunkCount       — total number of parts uploaded
  // meta.manifestChecksum — SHA-256 of all sorted chunk checksums
  // meta.session          — raw TransferSession for full DB persistence
};
```

Errors thrown inside `onCompleted` are caught and emitted as `log:error` events — they will **never** fail or cancel the upload.

---

## Engine Configuration

```typescript
createB2Engine({
  b2:    { ... },
  store: new FileSessionStore('./.sessions'),
  config: {
    chunkSize: 10 * 1024 * 1024,  // 10 MiB (default)
    concurrency: {
      initial:  4,
      min:      1,
      max:      16,
      adaptive: true,   // auto-tune based on throughput
    },
    retry: {
      maxAttempts: 5,
      baseDelayMs: 500,
      maxDelayMs:  30_000,
      jitterMs:    500,
    },
    checksumVerify: true,
  },
});
```

---

## Session Store

Use `FileSessionStore` for crash-safe persistence (required in production):

```typescript
import { FileSessionStore } from "@transferx/sdk";

// Use an absolute path so restarts always find the sessions
const store = new FileSessionStore("/absolute/path/.transferx-sessions");
```

Sessions are written atomically (tmp → rename) so a crash during a write never corrupts an existing session.

---

## Deterministic Session IDs

`makeSessionId()` generates a stable 24-hex-char SHA-256-based ID from the file path, target key, and file size. Using the same inputs twice returns the same ID, which prevents accidental duplicate uploads:

```typescript
import { makeSessionId } from "@transferx/sdk";

const id = makeSessionId("/data/video.mp4", "uploads/video.mp4", stat.size);
```

---

## Packages Included

| Package                   | Purpose                                         |
| ------------------------- | ----------------------------------------------- |
| `@transferx/core`         | Engine, state machine, retry, scheduler, stores |
| `@transferx/adapter-b2`   | Backblaze B2 adapter                            |
| `@transferx/adapter-s3`   | AWS S3 + Cloudflare R2 adapters                 |
| `@transferx/adapter-http` | Generic callback-based HTTP adapter             |
| `@transferx/downloader`   | IDM-class parallel download engine              |

---

## Links

- 📖 [Documentation](https://zed-syn.github.io/TransferX/)
- 🐙 [GitHub](https://github.com/zed-syn/TransferX)
- 📦 [@transferx/core](https://www.npmjs.com/package/@transferx/core)
- 📦 [@transferx/adapter-b2](https://www.npmjs.com/package/@transferx/adapter-b2)
- 📦 [@transferx/adapter-s3](https://www.npmjs.com/package/@transferx/adapter-s3)
- 📦 [@transferx/adapter-http](https://www.npmjs.com/package/@transferx/adapter-http)
- 📦 [@transferx/downloader](https://www.npmjs.com/package/@transferx/downloader)
