# @transferx/adapter-b2

[![npm](https://img.shields.io/npm/v/@transferx/adapter-b2)](https://www.npmjs.com/package/@transferx/adapter-b2)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/zed-syn/TransferX/blob/main/LICENSE)

> Backblaze B2 adapter for TransferX — chunked multipart uploads via the native B2 Large File API.

📖 **[Full documentation →](https://zed-syn.github.io/TransferX/)**  
🐙 **[GitHub →](https://github.com/zed-syn/TransferX)**

---

## Installation

Most users should install [`@transferx/sdk`](https://www.npmjs.com/package/@transferx/sdk) which includes this adapter pre-wired:

```bash
npm install @transferx/sdk
```

For direct use without the SDK:

```bash
npm install @transferx/adapter-b2 @transferx/core
```

---

## Quick Start (via SDK — recommended)

```typescript
import {
  createB2Engine,
  makeUploadSession,
  makeSessionId,
  FileSessionStore,
} from "@transferx/sdk";
import { statSync } from "fs";

const store = new FileSessionStore("./.transferx-sessions");

const { upload, bus, config } = createB2Engine({
  b2: {
    applicationKeyId: process.env.B2_APPLICATION_KEY_ID!,
    applicationKey: process.env.B2_APP_KEY!,
    bucketId: process.env.B2_BUCKET_ID!,
  },
  store,
  onCompleted: async (meta) => {
    console.log(
      `✓ ${meta.remoteKey} (${(meta.fileSizeBytes / 1e9).toFixed(2)} GB) in ${(meta.durationMs / 1000).toFixed(1)}s`,
    );
    console.log(`  checksum: ${meta.manifestChecksum}`);
  },
});

const filePath = "/data/video.mp4";
const targetKey = "uploads/2026/video.mp4";
const stat = statSync(filePath);

const session = makeUploadSession(
  makeSessionId(filePath, targetKey, stat.size),
  { name: "video.mp4", size: stat.size, mimeType: "video/mp4", path: filePath },
  targetKey,
  config,
);

await store.save(session);
await upload(session);
```

---

## Direct Usage (advanced)

```typescript
import { B2Adapter } from "@transferx/adapter-b2";
import { UploadEngine, FileSessionStore, EventBus } from "@transferx/core";

const adapter = new B2Adapter({
  applicationKeyId: process.env.B2_APPLICATION_KEY_ID!,
  applicationKey: process.env.B2_APP_KEY!,
  bucketId: process.env.B2_BUCKET_ID!,
});

const store = new FileSessionStore("./.sessions");
const bus = new EventBus();
const engine = new UploadEngine({ adapter, store, bus });
```

---

## Options

```typescript
interface B2AdapterOptions {
  /** B2 applicationKeyId (keyId from B2 console). */
  applicationKeyId: string;

  /** B2 applicationKey secret. */
  applicationKey: string;

  /** Target bucket ID (not bucket name). */
  bucketId: string;

  /**
   * HTTP request timeout per request.
   * Default: 120_000 ms (2 minutes)
   */
  timeoutMs?: number;

  /**
   * Custom fetch implementation. Defaults to global fetch (Node 18+).
   * Inject a mock in tests to avoid network calls.
   */
  fetch?: typeof fetch;

  /** Structured-log callback — wired automatically by createB2Engine(). */
  onLog?: (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    context?: Record<string, unknown>,
  ) => void;
}
```

---

## How It Works

The adapter maps TransferX's four lifecycle hooks to the B2 Large File API:

| TransferX hook       | B2 API call                                    |
| -------------------- | ---------------------------------------------- |
| `initTransfer()`     | `b2_authorize_account` → `b2_start_large_file` |
| `uploadChunk()`      | `b2_get_upload_part_url` → `b2_upload_part`    |
| `completeTransfer()` | `b2_finish_large_file`                         |
| `abortTransfer()`    | `b2_cancel_large_file`                         |
| `getRemoteState()`   | `b2_list_parts` (paginated)                    |

**Auth expiry is handled inline:** if a chunk upload receives a `401` from B2, the adapter transparently re-authorizes and retries before the RetryEngine sees the failure. This prevents a process running for hours from dying on a token expiry.

---

## Startup Recovery

```typescript
import { createB2Engine, FileSessionStore } from '@transferx/sdk';
import { TransferManager } from '@transferx/core';

const store   = new FileSessionStore('./.transferx-sessions');
const { bus } = createB2Engine({ b2: { ... }, store });

// Recover all in-progress sessions after process restart
const manager = new TransferManager({ adapter, store, bus });
const { resuming } = await manager.restoreFromStore();
console.log(`Resuming ${resuming.length} interrupted upload(s)`);
```

---

## Notes

- Requires **Node.js ≥ 18** (uses `globalThis.fetch`, `crypto.createHash`, `fs/promises`)
- B2 Large File API requires files ≥ 5 MiB; the default chunk size (10 MiB) satisfies this
- B2 multipart sessions expire after **7 days** of inactivity — do not pause uploads beyond this window

---

## Links

- 📖 [Documentation](https://zed-syn.github.io/TransferX/)
- 🐙 [GitHub](https://github.com/zed-syn/TransferX)
- 📦 [npm: @transferx/sdk](https://www.npmjs.com/package/@transferx/sdk) — includes this adapter
