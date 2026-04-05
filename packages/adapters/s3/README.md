# @transferx/adapter-s3

[![npm](https://img.shields.io/npm/v/@transferx/adapter-s3)](https://www.npmjs.com/package/@transferx/adapter-s3)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/zed-syn/TransferX/blob/main/LICENSE)

> AWS S3 and Cloudflare R2 adapters for TransferX — chunked multipart uploads via the AWS SDK v3.

Exports two adapters:

- **`S3Adapter`** — AWS S3 (standard regions, custom endpoints, path-style URLs)
- **`R2Adapter`** — Cloudflare R2 (pre-configured with correct endpoint and path-style)

📖 **[Full documentation →](https://zed-syn.github.io/TransferX/)**  
🐙 **[GitHub →](https://github.com/zed-syn/TransferX)**

---

## Installation

Most users should install [`@transferx/sdk`](https://www.npmjs.com/package/@transferx/sdk) which includes both adapters pre-wired:

```bash
npm install @transferx/sdk
```

For direct use without the SDK:

```bash
npm install @transferx/adapter-s3 @transferx/core
```

---

## Quick Start — S3 (via SDK — recommended)

```typescript
import {
  createS3Engine,
  makeUploadSession,
  makeSessionId,
  FileSessionStore,
} from "@transferx/sdk";
import { statSync } from "fs";

const store = new FileSessionStore("./.transferx-sessions");

const { upload, config } = createS3Engine({
  s3: {
    bucket: process.env.S3_BUCKET!,
    region: "us-east-1",
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  },
  store,
  onCompleted: async (meta) => {
    console.log(
      `✓ s3://${meta.remoteKey} uploaded in ${(meta.durationMs / 1000).toFixed(1)}s`,
    );
  },
});

const filePath = "/data/archive.tar.gz";
const targetKey = "backups/2026/archive.tar.gz";
const stat = statSync(filePath);

const session = makeUploadSession(
  makeSessionId(filePath, targetKey, stat.size),
  {
    name: "archive.tar.gz",
    size: stat.size,
    mimeType: "application/gzip",
    path: filePath,
  },
  targetKey,
  config,
);
await store.save(session);
await upload(session);
```

---

## Quick Start — Cloudflare R2 (via SDK — recommended)

```typescript
import {
  createR2Engine,
  makeUploadSession,
  makeSessionId,
  FileSessionStore,
} from "@transferx/sdk";
import { statSync } from "fs";

const store = new FileSessionStore("./.transferx-sessions");

const { upload, config } = createR2Engine({
  r2: {
    accountId: process.env.CF_ACCOUNT_ID!,
    bucket: process.env.R2_BUCKET!,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  },
  store,
});

const filePath = "/data/video.mp4";
const targetKey = "media/video.mp4";
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

## Direct Usage (advanced)

```typescript
import { S3Adapter, R2Adapter } from "@transferx/adapter-s3";
import { UploadEngine, FileSessionStore, EventBus } from "@transferx/core";

// AWS S3
const s3Adapter = new S3Adapter({
  bucket: "my-bucket",
  region: "us-east-1",
  credentials: { accessKeyId: "...", secretAccessKey: "..." },
});

// Cloudflare R2
const r2Adapter = new R2Adapter({
  accountId: "abc123...",
  bucket: "my-r2-bucket",
  credentials: { accessKeyId: "...", secretAccessKey: "..." },
});

const engine = new UploadEngine({
  adapter: s3Adapter, // or r2Adapter
  store: new FileSessionStore("./.sessions"),
  bus: new EventBus(),
});
```

---

## S3AdapterOptions

```typescript
interface S3AdapterOptions {
  /** Target S3 bucket name. */
  bucket: string;

  /**
   * AWS region. Defaults to "us-east-1".
   * For R2 use "auto" or omit.
   */
  region?: string;

  /** AWS credentials (never logged). */
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string; // for temporary STS credentials
  };

  /**
   * Custom endpoint for S3-compatible storage.
   * Required for R2: "https://<account-id>.r2.cloudflarestorage.com"
   */
  endpoint?: string;

  /**
   * Use path-style URLs (/bucket/key) instead of virtual-hosted.
   * Automatically set to true for R2Adapter.
   */
  forcePathStyle?: boolean;

  /** Per-request timeout. Default: 120_000 ms */
  timeoutMs?: number;

  /** Log callback — wired automatically by createS3Engine() / createR2Engine(). */
  onLog?: (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    context?: Record<string, unknown>,
  ) => void;
}
```

**`R2Adapter`** accepts the same shape plus a required `accountId: string` field — `endpoint` and `forcePathStyle` are set automatically.

---

## How It Works

The adapter maps TransferX's lifecycle hooks to the S3 Multipart Upload API (via `@aws-sdk/client-s3`):

| TransferX hook       | S3 API call                      |
| -------------------- | -------------------------------- |
| `initTransfer()`     | `CreateMultipartUploadCommand`   |
| `uploadChunk()`      | `UploadPartCommand`              |
| `completeTransfer()` | `CompleteMultipartUploadCommand` |
| `abortTransfer()`    | `AbortMultipartUploadCommand`    |
| `getRemoteState()`   | `ListPartsCommand` (paginated)   |

---

## Startup Recovery

```typescript
import { TransferManager } from "@transferx/core";

const manager = new TransferManager({ adapter: s3Adapter, store, bus });
const { resuming } = await manager.restoreFromStore();
console.log(`Resuming ${resuming.length} interrupted upload(s)`);
```

---

## Notes

- Requires **Node.js ≥ 18**
- S3 multipart requires part size ≥ 5 MiB (except last); the default 10 MiB chunk size satisfies this
- Temporary credentials (`sessionToken`) are supported for AWS STS / IAM role assumption

---

## Links

- 📖 [Documentation](https://zed-syn.github.io/TransferX/)
- 🐙 [GitHub](https://github.com/zed-syn/TransferX)
- 📦 [npm: @transferx/sdk](https://www.npmjs.com/package/@transferx/sdk) — includes this adapter
