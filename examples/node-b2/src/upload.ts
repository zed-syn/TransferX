/**
 * Example: upload a local file to Backblaze B2
 *
 * Run:
 *   B2_APPLICATION_KEY_ID=xxx B2_APP_KEY=xxx B2_BUCKET_ID=xxx \
 *   FILE=/path/to/file.mp4 TARGET_KEY=uploads/file.mp4 \
 *   npx ts-node --esm src/upload.ts
 *
 * Required env vars:
 *   B2_APPLICATION_KEY_ID  — Backblaze B2 application key ID
 *   B2_APP_KEY             — application key secret
 *   B2_BUCKET_ID           — target bucket ID
 *   FILE            — absolute path to the local file
 *   TARGET_KEY      — remote object path inside the bucket (e.g. uploads/video.mp4)
 *
 * Optional env vars:
 *   CHUNK_SIZE_MB   — chunk size in MiB (default: 10)
 *   CONCURRENCY     — parallel chunk uploads (default: 4)
 */

import * as fs from "fs";
import * as path from "path";
import {
  createB2Engine,
  makeUploadSession,
  FileSessionStore,
} from "@transferx/sdk";

// ── Read environment ──────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return val;
}

const applicationKeyId = requireEnv("B2_APPLICATION_KEY_ID");
const applicationKey = requireEnv("B2_APP_KEY");
const bucketId = requireEnv("B2_BUCKET_ID");
const filePath = requireEnv("FILE");
const targetKey = requireEnv("TARGET_KEY");

const chunkSizeMB = parseInt(process.env["CHUNK_SIZE_MB"] ?? "10", 10);
const concurrency = parseInt(process.env["CONCURRENCY"] ?? "4", 10);

// ── Validate file exists ──────────────────────────────────────────────────────

if (!fs.existsSync(filePath)) {
  console.error(`File not found: ${filePath}`);
  process.exit(1);
}

const stat = fs.statSync(filePath);
const fileName = path.basename(filePath);

// ── Set up engine ─────────────────────────────────────────────────────────────

// Use a file-backed store so uploads can be resumed after a crash
const storeDir = path.join(process.cwd(), ".transferx-sessions");
const store = new FileSessionStore(storeDir);

const { upload, bus, config } = createB2Engine({
  b2: { applicationKeyId, applicationKey, bucketId },
  config: {
    chunkSize: chunkSizeMB * 1024 * 1024,
    concurrency: { initial: concurrency, min: 1, max: 16, adaptive: false },
  },
  store,
});

// ── Subscribe to events ───────────────────────────────────────────────────────

bus.on("session:started", ({ session }) => {
  console.log(`[TransferX] Upload started: ${session.id}`);
  console.log(
    `  File      : ${session.file.name} (${(session.file.size / 1e6).toFixed(2)} MB)`,
  );
  console.log(
    `  Chunks    : ${Math.ceil(session.file.size / config.chunkSize)}`,
  );
  console.log(`  Concurrency: ${concurrency}`);
});

bus.on("progress", ({ progress }) => {
  const speed = (progress.speedBytesPerSec / 1e6).toFixed(2);
  const eta =
    progress.etaSeconds !== undefined
      ? `${progress.etaSeconds.toFixed(0)}s remaining`
      : "calculating…";
  process.stdout.write(
    `\r  ${progress.percent.toFixed(1)}%  ${speed} MB/s  ${eta}    `,
  );
});

bus.on("chunk:fatal", ({ chunk, error }) => {
  console.error(
    `\n[TransferX] Chunk ${chunk.index} failed fatally: ${error.message}`,
  );
});

bus.on("session:done", ({ session }) => {
  console.log(`\n[TransferX] Upload complete: ${session.id}`);
  console.log(
    `  Transferred: ${(session.transferredBytes / 1e6).toFixed(2)} MB`,
  );
});

bus.on("session:failed", ({ session, error }) => {
  console.error(`\n[TransferX] Upload failed: ${error.message}`);
  console.error(
    `  Session ID: ${session.id} — stored in ${storeDir} for resume`,
  );
});

// ── Build session and start upload ────────────────────────────────────────────

async function main(): Promise<void> {
  const sessionId = `upload-${Date.now()}`;
  const session = makeUploadSession(
    sessionId,
    {
      name: fileName,
      size: stat.size,
      mimeType: guessMimeType(fileName),
      path: filePath,
    },
    targetKey,
    config,
  );

  await store.save(session);

  const result = await upload(session);

  if (result.state !== "done") {
    process.exit(1);
  }
}

function guessMimeType(name: string): string {
  const ext = path.extname(name).toLowerCase();
  const mime: Record<string, string> = {
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".avi": "video/x-msvideo",
    ".mkv": "video/x-matroska",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".pdf": "application/pdf",
    ".zip": "application/zip",
    ".tar": "application/x-tar",
    ".gz": "application/gzip",
  };
  return mime[ext] ?? "application/octet-stream";
}

main().catch((err: unknown) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
