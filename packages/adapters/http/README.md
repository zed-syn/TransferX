# @transferx/adapter-http

[![npm](https://img.shields.io/npm/v/@transferx/adapter-http)](https://www.npmjs.com/package/@transferx/adapter-http)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/zed-syn/TransferX/blob/main/LICENSE)

> Generic callback-based HTTP adapter for TransferX — integrate any custom multipart upload API without writing a full adapter.

Instead of hard-coding a specific provider's wire format, this adapter delegates every upload lifecycle step to **caller-supplied async functions**. All network, authentication, and credential concerns remain entirely in your code.

📖 **[Full documentation →](https://zed-syn.github.io/TransferX/)**  
🐙 **[GitHub →](https://github.com/zed-syn/TransferX)**

---

## Installation

Most users should install [`@transferx/sdk`](https://www.npmjs.com/package/@transferx/sdk) which includes this adapter pre-wired via `createHttpEngine()`:

```bash
npm install @transferx/sdk
```

For direct use without the SDK:

```bash
npm install @transferx/adapter-http @transferx/core
```

---

## Quick Start (via SDK — recommended)

```typescript
import {
  createHttpEngine,
  makeUploadSession,
  makeSessionId,
  FileSessionStore,
} from "@transferx/sdk";
import { statSync } from "fs";

const store = new FileSessionStore("./.transferx-sessions");

const { upload, config } = createHttpEngine({
  store,
  http: {
    initFn: async (session) => {
      const res = await fetch("/api/uploads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: session.targetKey,
          size: session.file.size,
        }),
      });
      const { uploadId } = (await res.json()) as { uploadId: string };
      return uploadId;
    },

    uploadFn: async (session, chunk, data, sha256Hex) => {
      const res = await fetch(
        `/api/uploads/${session.providerSessionId}/parts/${chunk.index + 1}`,
        {
          method: "PUT",
          body: data,
          headers: { "x-checksum-sha256": sha256Hex },
        },
      );
      const { etag } = (await res.json()) as { etag: string };
      return etag; // stored as chunk.providerToken, forwarded to completeFn
    },

    completeFn: async (session, chunks) => {
      await fetch(`/api/uploads/${session.providerSessionId}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parts: chunks.map((c) => ({
            partNumber: c.index + 1,
            etag: c.providerToken,
          })),
        }),
      });
    },

    abortFn: async (session) => {
      await fetch(`/api/uploads/${session.providerSessionId}`, {
        method: "DELETE",
      }).catch(() => undefined);
    },
  },

  onCompleted: async (meta) => {
    console.log(
      `Uploaded ${meta.remoteKey} in ${(meta.durationMs / 1000).toFixed(1)}s`,
    );
  },
});

const filePath = "/data/video.mp4";
const targetKey = "uploads/video.mp4";
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
import { createHttpAdapter, HttpAdapter } from "@transferx/adapter-http";
import { UploadEngine, FileSessionStore, EventBus } from "@transferx/core";

const adapter = createHttpAdapter({
  initFn: async (session) => myApi.createUpload(session.targetKey),
  uploadFn: async (session, chunk, data) =>
    myApi.uploadPart(session.providerSessionId!, chunk.index + 1, data),
  completeFn: async (session, chunks) =>
    myApi.completeUpload(session.providerSessionId!, chunks),
  abortFn: async (session) =>
    myApi.abortUpload(session.providerSessionId!).catch(() => undefined),
});

const engine = new UploadEngine({
  adapter,
  store: new FileSessionStore("./.sessions"),
  bus: new EventBus(),
});
```

---

## Callback Reference

```typescript
interface HttpAdapterOptions {
  /**
   * Called once to initiate the remote multipart session.
   * @returns Provider-assigned session ID — stored as session.providerSessionId
   *          and passed to all subsequent calls.
   */
  initFn: (session: TransferSession) => Promise<string>;

  /**
   * Called once per chunk.
   * @param data       Raw bytes of this chunk.
   * @param sha256Hex  Pre-computed SHA-256 hex digest — forward to server for integrity verification.
   * @returns          Opaque per-chunk token (e.g. ETag) — stored as chunk.providerToken,
   *                   forwarded as-is to completeFn.
   */
  uploadFn: (
    session: TransferSession,
    chunk: ChunkMeta,
    data: Uint8Array,
    sha256Hex: string,
  ) => Promise<string>;

  /**
   * Called once after all chunks succeed to finalize the upload.
   * chunks[].providerToken contains the tokens returned by each uploadFn call.
   */
  completeFn: (session: TransferSession, chunks: ChunkMeta[]) => Promise<void>;

  /**
   * Called on cancel or fatal error. Best-effort — do not throw.
   * If omitted, abort is a no-op.
   */
  abortFn?: (session: TransferSession) => Promise<void>;

  /**
   * Optional server-side resume reconciliation.
   * Return already-uploaded parts so the engine can skip re-uploading them.
   * If omitted, the engine trusts the local session state on resume.
   */
  getRemoteStateFn?: (session: TransferSession) => Promise<RemoteUploadState>;
}
```

---

## Server-Side Resume (optional)

If your API supports listing already-uploaded parts, implement `getRemoteStateFn` to enable accurate server-side resume. Without it, resume still works via local session state:

```typescript
getRemoteStateFn: async (session) => {
  const { parts } = await myApi.listParts(session.providerSessionId!);
  return {
    uploadedParts: parts.map(p => ({
      partNumber: p.number,   // 1-based
      checksum:   p.sha256,
    })),
  };
},
```

---

## Security

- The adapter **never inspects, logs, or stores** credentials or request bodies
- All authentication is handled by your `initFn` / `uploadFn` implementations
- `sha256Hex` is computed by the engine from the raw chunk bytes — safe to forward as an integrity header
- `abortFn` errors are silently swallowed — ensure your server-side cleanup is idempotent

---

## Links

- 📖 [Documentation](https://zed-syn.github.io/TransferX/)
- 🐙 [GitHub](https://github.com/zed-syn/TransferX)
- 📦 [npm: @transferx/sdk](https://www.npmjs.com/package/@transferx/sdk) — includes this adapter
