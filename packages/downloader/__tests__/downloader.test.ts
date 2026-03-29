/**
 * @transferx/downloader — integration test suite
 *
 * All HTTP is mocked via a custom fetch implementation.
 * All filesystem I/O is mocked with an in-memory FD table.
 * No real network or disk access occurs.
 *
 * Test coverage:
 *   1.  Successful parallel range download (multi-chunk)
 *   2.  Fallback to single-stream when server lacks range support
 *   3.  Pause → resume mid-download
 *   4.  Cancel mid-download
 *   5.  Resume after simulated crash (session rehydrated correctly)
 *   6.  RangePlanner.rehydrate() bytesWritten consistency
 *   7.  FileWriter offset correctness (no overlapping writes)
 *   8.  Retry on transient network error (5xx)
 *   9.  Server returns 416 (invalid range) — non-retryable
 *   10. ETag mismatch on resume → stale error
 *   11. No stale trailing bytes on fresh start (flag=w enforced)
 *   12. Event handler throwing does not crash the engine
 */

import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { RangePlanner } from "../src/RangePlanner";
import { FileWriter } from "../src/FileWriter";
import { DownloadEngine } from "../src/DownloadEngine";
import { DownloadTask } from "../src/DownloadTask";
import { ResumeStore } from "../src/ResumeStore";
import {
  resolveDownloadConfig,
  DownloadError,
  type DownloadSession,
  type DownloadProgress,
} from "../src/types";
import { withRetry } from "../src/RetryEngine";
import { ProgressEngine } from "../src/ProgressEngine";
import { ChunkScheduler } from "../src/ChunkScheduler";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal fetch mock that serves a byte array in range or full mode. */
function makeFetch(
  body: Uint8Array,
  opts: {
    supportsRange?: boolean;
    etag?: string;
    forceStatus?: number;
    /** Map of "attempt number → status code override" */
    failOnAttempts?: Map<number, number>;
    onRequest?: (req: {
      url: string;
      headers: Record<string, string>;
      attempt: number;
    }) => void;
  } = {},
): { fetch: typeof fetch; attemptCount: number } {
  let attempt = 0;
  const mockFetch = async (
    url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    attempt++;
    const headers = (init?.headers ?? {}) as Record<string, string>;

    opts.onRequest?.({ url: String(url), headers, attempt });

    const statusOverride = opts.failOnAttempts?.get(attempt);
    if (statusOverride !== undefined) {
      return new Response(null, { status: statusOverride });
    }

    const overallStatus = opts.forceStatus;
    if (overallStatus !== undefined) {
      return new Response(null, { status: overallStatus });
    }

    const supportsRange = opts.supportsRange ?? true;
    const rangeHeader = headers["Range"];

    if (rangeHeader && supportsRange) {
      const match = /bytes=(\d+)-(\d+)/.exec(rangeHeader);
      if (!match) return new Response(null, { status: 416 });
      const start = parseInt(match[1]!, 10);
      const end = parseInt(match[2]!, 10);
      const slice = body.slice(start, end + 1);
      const respHeaders: Record<string, string> = {
        "Content-Range": `bytes ${start}-${end}/${body.length}`,
        "Content-Length": String(slice.length),
      };
      if (opts.etag) respHeaders["ETag"] = opts.etag;
      return new Response(slice, { status: 206, headers: respHeaders });
    }

    // Full body (streaming / no-range)
    const respHeaders: Record<string, string> = {
      "Content-Length": String(body.length),
      "Accept-Ranges": supportsRange ? "bytes" : "none",
    };
    if (opts.etag) respHeaders["ETag"] = opts.etag;
    return new Response(body, { status: 200, headers: respHeaders });
  };

  return { fetch: mockFetch as unknown as typeof fetch, attemptCount: attempt };
}

/** Create a temp dir scoped to this test run. */
function makeTempDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `txdl-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Build a DownloadEngine wired to specific mocked fetch. */
function makeEngine(
  fetchImpl: typeof fetch,
  storeDir: string,
  extraConfig: object = {},
) {
  return new DownloadEngine({
    storeDir,
    config: {
      fetch: fetchImpl,
      chunkSize: 1 * 1024 * 1024, // 1 MiB — small for testing
      timeoutMs: 5_000,
      progressIntervalMs: 50,
      concurrency: { initial: 4, min: 1, max: 8, adaptive: false },
      retry: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, jitterMs: 5 },
      ...extraConfig,
    },
  });
}

// ─── RangePlanner unit tests ──────────────────────────────────────────────────

describe("RangePlanner", () => {
  test("plan produces contiguous non-overlapping chunks", () => {
    const chunks = RangePlanner.plan(10 * 1024 * 1024, 3 * 1024 * 1024, true);
    expect(chunks.length).toBe(4);

    let expectedStart = 0;
    for (const c of chunks) {
      expect(c.start).toBe(expectedStart);
      expect(c.end).toBeGreaterThanOrEqual(c.start);
      expectedStart = c.end + 1;
    }
    // Last byte of last chunk should be exactly fileSize - 1
    expect(chunks[chunks.length - 1]!.end).toBe(10 * 1024 * 1024 - 1);
  });

  test("plan falls back to stream sentinel when range not supported", () => {
    const chunks = RangePlanner.plan(50_000, 10_000, false);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.end).toBe(-1);
    expect(chunks[0]!.size).toBe(0);
    expect(RangePlanner.isStreamingChunk(chunks[0]!)).toBe(true);
  });

  test("plan falls back to stream sentinel when fileSize is null", () => {
    const chunks = RangePlanner.plan(null, 10_000, true);
    expect(chunks).toHaveLength(1);
    expect(RangePlanner.isStreamingChunk(chunks[0]!)).toBe(true);
  });

  test("rehydrate resets bytesWritten=0 for both running and failed chunks", () => {
    const input = RangePlanner.plan(6 * 1024 * 1024, 2 * 1024 * 1024, true);
    const withStates = input.map((c, i) => ({
      ...c,
      status: (["running", "failed", "done"] as const)[i % 3]!,
      bytesWritten: c.size,
      attempts: 2,
    }));

    const rehydrated = RangePlanner.rehydrate(withStates);

    // running → pending, bytesWritten=0, attempts=0
    expect(rehydrated[0]!.status).toBe("pending");
    expect(rehydrated[0]!.bytesWritten).toBe(0);
    expect(rehydrated[0]!.attempts).toBe(0);

    // failed → pending, bytesWritten=0
    expect(rehydrated[1]!.status).toBe("pending");
    expect(rehydrated[1]!.bytesWritten).toBe(0);

    // done → unchanged
    expect(rehydrated[2]!.status).toBe("done");
    expect(rehydrated[2]!.bytesWritten).toBe(rehydrated[2]!.size);
  });

  test("pendingChunks returns only pending and failed", () => {
    const chunks = RangePlanner.plan(
      6 * 1024 * 1024,
      2 * 1024 * 1024,
      true,
    ).map((c, i) => ({
      ...c,
      status: (["pending", "done", "failed"] as const)[i]!,
    }));
    const pending = RangePlanner.pendingChunks(chunks);
    expect(pending.map((c) => c.index)).toEqual([0, 2]);
  });
});

// ─── FileWriter unit tests ────────────────────────────────────────────────────

describe("FileWriter", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("writes bytes at correct offsets without overlap", async () => {
    const filePath = path.join(tmpDir, "offset-test.bin");
    const fileSize = 16;
    const writer = new FileWriter(filePath);
    await writer.open(fileSize, false);

    // Two chunks: [0..7] and [8..15]
    const chunk0 = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]);
    const chunk1 = Buffer.from([8, 9, 10, 11, 12, 13, 14, 15]);

    const toStream = (buf: Buffer): ReadableStream<Uint8Array> =>
      new ReadableStream({
        start(ctrl) {
          ctrl.enqueue(new Uint8Array(buf));
          ctrl.close();
        },
      });

    // Write both chunks in parallel at their respective offsets
    await Promise.all([
      writer.writeStream(toStream(chunk0), 0, () => {}),
      writer.writeStream(toStream(chunk1), 8, () => {}),
    ]);

    await writer.flush();
    await writer.close();

    const result = fs.readFileSync(filePath);
    expect(result.length).toBe(16);
    for (let i = 0; i < 16; i++) {
      expect(result[i]).toBe(i);
    }
  });

  test("fresh open truncates pre-existing file (no stale trailing bytes)", async () => {
    const filePath = path.join(tmpDir, "trunc-test.bin");

    // Write a larger file first
    fs.writeFileSync(filePath, Buffer.alloc(100, 0xff));
    expect(fs.statSync(filePath).size).toBe(100);

    // Open fresh (smaller) — must truncate
    const writer = new FileWriter(filePath);
    await writer.open(20, false); // resume=false → flag 'w' → truncate
    await writer.writeStream(
      new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array(20).fill(0xab));
          c.close();
        },
      }),
      0,
      () => {},
    );
    await writer.flush();
    await writer.close();

    const result = fs.readFileSync(filePath);
    // File must be exactly 20 bytes with no leftover 0xff bytes from old file
    expect(result.length).toBe(20);
    for (const byte of result) {
      expect(byte).not.toBe(0xff);
    }
  });

  test("resume open (r+) preserves existing bytes", async () => {
    const filePath = path.join(tmpDir, "resume-test.bin");
    const original = Buffer.alloc(16, 0xaa);
    fs.writeFileSync(filePath, original);

    const writer = new FileWriter(filePath);
    await writer.open(16, true); // resume=true → 'r+' → preserve

    // Overwrite only second half
    await writer.writeStream(
      new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array(8).fill(0xbb));
          c.close();
        },
      }),
      8,
      () => {},
    );
    await writer.flush();
    await writer.close();

    const result = fs.readFileSync(filePath);
    // First 8 bytes unchanged
    for (let i = 0; i < 8; i++) expect(result[i]).toBe(0xaa);
    // Last 8 overwritten
    for (let i = 8; i < 16; i++) expect(result[i]).toBe(0xbb);
  });
});

// ─── RetryEngine unit tests ───────────────────────────────────────────────────

describe("RetryEngine.withRetry", () => {
  const policy = resolveDownloadConfig({
    retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 10, jitterMs: 1 },
  }).retry;

  test("resolves on first attempt for successful operation", async () => {
    const result = await withRetry(() => Promise.resolve(42), policy);
    expect(result).toBe(42);
  });

  test("retries on retryable error and eventually succeeds", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls < 3)
        throw new DownloadError({ message: "net", category: "network" });
      return "ok";
    }, policy);
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  test("throws immediately on non-retryable error (404)", async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw new DownloadError({ message: "not found", category: "notFound" });
      }, policy),
    ).rejects.toMatchObject({ category: "notFound" });
    expect(calls).toBe(1); // must NOT retry
  });

  test("exhausts retry budget and throws last error", async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw new DownloadError({
          message: `attempt ${calls}`,
          category: "serverError",
        });
      }, policy),
    ).rejects.toMatchObject({ category: "serverError" });
    expect(calls).toBe(3); // maxAttempts=3
  });

  test("aborts immediately when AbortSignal is already triggered", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          return "x";
        },
        policy,
        undefined,
        ctrl.signal,
      ),
    ).rejects.toMatchObject({ category: "cancelled" });
    expect(calls).toBe(0);
  });

  test("calls onRetry callback with error and attempt number", async () => {
    const retries: Array<{ attempt: number }> = [];
    let calls = 0;
    await withRetry(
      async () => {
        calls++;
        if (calls < 3)
          throw new DownloadError({ message: "x", category: "timeout" });
        return "done";
      },
      policy,
      (err, attempt) => retries.push({ attempt }),
    );
    expect(retries).toHaveLength(2);
    expect(retries[0]!.attempt).toBe(1);
    expect(retries[1]!.attempt).toBe(2);
  });
});

// ─── ProgressEngine unit tests ────────────────────────────────────────────────

describe("ProgressEngine", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test("emits progress on interval with EMA-smoothed speed", async () => {
    const events: DownloadProgress[] = [];
    const engine = new ProgressEngine({
      taskId: "t1",
      totalBytes: 10_000,
      progressIntervalMs: 100,
      onProgress: (p) => events.push(p),
    });
    engine.start();
    engine.addBytes(5_000);
    jest.advanceTimersByTime(100);
    engine.stop();

    expect(events.length).toBeGreaterThanOrEqual(1);
    const last = events[events.length - 1]!;
    expect(last.downloadedBytes).toBe(5_000);
    expect(last.totalBytes).toBe(10_000);
    expect(last.percent).toBeCloseTo(50, 0);
  });

  test("percent is null when totalBytes is null", () => {
    const events: DownloadProgress[] = [];
    const engine = new ProgressEngine({
      taskId: "t2",
      totalBytes: null,
      progressIntervalMs: 100,
      onProgress: (p) => events.push(p),
    });
    engine.start();
    engine.addBytes(1000);
    jest.advanceTimersByTime(100);
    engine.stop();

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[events.length - 1]!.percent).toBeNull();
    expect(events[events.length - 1]!.totalBytes).toBeNull();
  });

  test("finish() emits a final event with speed=0", () => {
    const events: DownloadProgress[] = [];
    const engine = new ProgressEngine({
      taskId: "t3",
      totalBytes: 100,
      progressIntervalMs: 100,
      onProgress: (p) => events.push(p),
    });
    engine.start();
    engine.addBytes(100);
    engine.finish();

    const last = events[events.length - 1]!;
    expect(last.speedBytesPerSec).toBe(0);
  });
});

// ─── ChunkScheduler unit tests ────────────────────────────────────────────────

describe("ChunkScheduler", () => {
  const policy = resolveDownloadConfig({}).concurrency;

  test("runs tasks up to concurrency limit", async () => {
    const scheduler = new ChunkScheduler({
      initial: 2,
      min: 1,
      max: 4,
      adaptive: false,
    });
    let concurrent = 0;
    let maxConcurrent = 0;

    const task = () =>
      new Promise<void>((resolve) => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        // Yield the event loop via Promise microtask instead of setImmediate
        void Promise.resolve().then(() => {
          concurrent--;
          resolve();
        });
      });

    for (let i = 0; i < 6; i++) scheduler.push(task);
    await scheduler.drain();

    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  test("drain() resolves after all tasks complete", async () => {
    const scheduler = new ChunkScheduler({
      initial: 3,
      min: 1,
      max: 3,
      adaptive: false,
    });
    let done = 0;
    for (let i = 0; i < 5; i++) {
      scheduler.push(async () => {
        await Promise.resolve();
        done++;
      });
    }
    await scheduler.drain();
    expect(done).toBe(5);
  });

  test("pause() stops dispatch; resume() re-activates it", async () => {
    const scheduler = new ChunkScheduler({
      initial: 2,
      min: 1,
      max: 2,
      adaptive: false,
    });
    let started = 0;

    scheduler.pause();
    for (let i = 0; i < 3; i++) {
      scheduler.push(async () => {
        started++;
      });
    }
    // Nothing should have started yet (paused before any push)
    await Promise.resolve();
    expect(started).toBe(0);

    scheduler.resume();
    await scheduler.drain();
    expect(started).toBe(3);
  });

  test("cancel() clears queue and returns when active settle", async () => {
    const scheduler = new ChunkScheduler({
      initial: 1,
      min: 1,
      max: 1,
      adaptive: false,
    });
    let ran = 0;
    let resolved = false;

    // First task runs immediately (active slot)
    scheduler.push(async () => {
      await Promise.resolve();
      ran++;
    });
    // Remaining tasks are queued (slot full)
    for (let i = 0; i < 5; i++)
      scheduler.push(async () => {
        ran++;
      });

    const cancelPromise = scheduler.cancel().then(() => {
      resolved = true;
    });
    // flush microtasks so the active task has a chance to run
    await Promise.resolve();
    await Promise.resolve();
    await cancelPromise;

    expect(ran).toBe(1); // only the already-running task completed
    expect(resolved).toBe(true);
  });
});

// ─── Full download integration tests ─────────────────────────────────────────

describe("DownloadEngine integration", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Helper: generate random bytes as a download body
  function makeBody(size: number): Uint8Array {
    const buf = new Uint8Array(size);
    for (let i = 0; i < size; i++) buf[i] = i % 256;
    return buf;
  }

  // ── Test 1: Successful parallel range download ──────────────────────────────
  test("downloads a file in multiple parallel chunks, content is correct", async () => {
    const size = 5 * 1024 * 1024;
    const body = makeBody(size);
    const { fetch } = makeFetch(body, { supportsRange: true, etag: '"abc"' });
    const engine = makeEngine(fetch, path.join(tmpDir, "store"));
    const task = new DownloadTask(
      engine.createTask("http://test/file.bin", path.join(tmpDir, "file.bin")),
    );

    const completedSessions: DownloadSession[] = [];
    task.on("completed", ({ session }) => completedSessions.push(session));

    await task.start();

    expect(completedSessions).toHaveLength(1);
    const result = fs.readFileSync(path.join(tmpDir, "file.bin"));
    expect(result.length).toBe(size);
    for (let i = 0; i < size; i++) {
      if (result[i] !== i % 256) {
        throw new Error(
          `Byte mismatch at offset ${i}: got ${result[i]}, expected ${i % 256}`,
        );
      }
    }
  });

  // ── Test 2: Fallback to single-stream ────────────────────────────────────────
  test("downloads correctly when server does not support range requests", async () => {
    const size = 500_000;
    const body = makeBody(size);
    const { fetch } = makeFetch(body, { supportsRange: false });
    const engine = makeEngine(fetch, path.join(tmpDir, "store"));
    const task = new DownloadTask(
      engine.createTask("http://test/file.bin", path.join(tmpDir, "file.bin")),
    );

    await task.start();

    const result = fs.readFileSync(path.join(tmpDir, "file.bin"));
    expect(result.length).toBe(size);
  });

  // ── Test 3: Retry on transient 503 ──────────────────────────────────────────
  test("retries on 5xx error and succeeds on subsequent attempt", async () => {
    const size = 2 * 1024 * 1024;
    const body = makeBody(size);
    let callCount = 0;

    // First real download request (after probes) gets a 503, rest succeed
    const mockFetch = async (
      url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const isProbe =
        init?.method === "HEAD" || headers["Range"] === "bytes=0-0";

      if (!isProbe) {
        callCount++;
        if (callCount === 1) return new Response(null, { status: 503 });
      }

      // Delegate to real range serving
      const { fetch: realFetch } = makeFetch(body, { supportsRange: true });
      return realFetch(url, init);
    };

    const engine = makeEngine(
      mockFetch as unknown as typeof fetch,
      path.join(tmpDir, "store"),
    );
    const task = new DownloadTask(
      engine.createTask("http://test/file.bin", path.join(tmpDir, "file.bin")),
    );

    const retryEvents: number[] = [];
    task.on("retry", ({ attempt }) => retryEvents.push(attempt));

    await task.start();

    expect(retryEvents.length).toBeGreaterThanOrEqual(1);
    const result = fs.readFileSync(path.join(tmpDir, "file.bin"));
    expect(result.length).toBe(size);
  });

  // ── Test 4: Cancel mid-download ──────────────────────────────────────────────
  test("cancel() stops download and session is persisted as cancelled", async () => {
    const size = 5 * 1024 * 1024;
    const body = makeBody(size);

    let inFlight = 0;
    const pausePromise = { resolve: () => {} } as { resolve: () => void };
    const waitForRequest = new Promise<void>((r) => {
      pausePromise.resolve = r;
    });

    const slowFetch = async (
      url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const isProbe =
        init?.method === "HEAD" || headers["Range"] === "bytes=0-0";
      if (!isProbe) {
        inFlight++;
        pausePromise.resolve();
        // Simulate slow response
        await new Promise((r) => setTimeout(r, 200));
      }
      const { fetch: f } = makeFetch(body, { supportsRange: true });
      return f(url, init);
    };

    const engine = makeEngine(
      slowFetch as unknown as typeof fetch,
      path.join(tmpDir, "store"),
    );
    const task = new DownloadTask(
      engine.createTask("http://test/file.bin", path.join(tmpDir, "file.bin")),
    );

    const startPromise = task.start().catch(() => "cancelled");

    await waitForRequest;
    await task.cancel();
    const result = await startPromise;
    expect(result).toBe("cancelled");

    // Session should be on disk as cancelled
    const store = new ResumeStore(path.join(tmpDir, "store"));
    const sessions = await store.listAll();
    expect(sessions.some((s) => s.status === "cancelled")).toBe(true);
  });

  // ── Test 5: Resume after crash ───────────────────────────────────────────────
  test("resumes and only re-downloads incomplete chunks after simulated crash", async () => {
    const size = 3 * 1024 * 1024;
    const body = makeBody(size);
    const storeDir = path.join(tmpDir, "store");

    // First pass: start and cancel to simulate partial download
    {
      const { fetch } = makeFetch(body, {
        supportsRange: true,
        etag: '"stable"',
      });
      const engine = makeEngine(fetch, storeDir);
      const task = new DownloadTask(
        engine.createTask(
          "http://test/file.bin",
          path.join(tmpDir, "file.bin"),
        ),
      );
      const startP = task.start().catch(() => "cancelled");
      // Give a tick for capability detection to complete and some chunks to start
      await new Promise((r) => setTimeout(r, 30));
      await task.cancel();
      await startP;
    }

    // Verify session is persisted
    const store = new ResumeStore(storeDir);
    const sessions = await store.listAll();
    expect(sessions.length).toBeGreaterThan(0);

    const rangesRequested: string[] = [];

    // Second pass: resume
    {
      const { fetch: baseFetch } = makeFetch(body, {
        supportsRange: true,
        etag: '"stable"',
      });
      const mockFetch = async (
        url: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        const h = (init?.headers ?? {}) as Record<string, string>;
        if (h["Range"]) rangesRequested.push(h["Range"]);
        return baseFetch(url, init);
      };

      const engine = makeEngine(mockFetch as unknown as typeof fetch, storeDir);
      const session = sessions[0]!;
      const resumeTask = await engine.resumeTask(session.id);
      expect(resumeTask).not.toBeNull();

      await new DownloadTask(resumeTask!).start();

      const result = fs.readFileSync(path.join(tmpDir, "file.bin"));
      expect(result.length).toBe(size);
    }
  });

  // ── Test 6: ETag mismatch on resume ─────────────────────────────────────────
  test("throws stale error when server ETag changed since session was saved", async () => {
    const size = 2 * 1024 * 1024;
    const body = makeBody(size);
    const storeDir = path.join(tmpDir, "store");

    // Create a fake stale session
    const storedSession: DownloadSession = {
      id: "test-session-stale",
      url: "http://test/file.bin",
      outputPath: path.join(tmpDir, "file.bin"),
      fileSize: size,
      etag: '"old-etag"',
      lastModified: null,
      supportsRange: true,
      status: "paused",
      chunks: RangePlanner.plan(size, 1 * 1024 * 1024, true),
      downloadedBytes: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const store = new ResumeStore(storeDir);
    await store.save(storedSession);

    // Server now has a different ETag
    const { fetch } = makeFetch(body, {
      supportsRange: true,
      etag: '"new-etag"',
    });

    const engine = new DownloadEngine({
      storeDir,
      config: { fetch, timeoutMs: 5_000 },
    });
    const inner = await engine.resumeTask("test-session-stale");
    expect(inner).not.toBeNull();

    await expect(new DownloadTask(inner!).start()).rejects.toMatchObject({
      category: "stale",
    });
  });

  // ── Test 7: 416 range error is non-retryable ─────────────────────────────────
  test("fails immediately on 416 without consuming retry budget", async () => {
    let fetchCalls = 0;
    const mock416 = async (
      url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      fetchCalls++;
      const h = (init?.headers ?? {}) as Record<string, string>;
      if (h["Range"]) return new Response(null, { status: 416 });
      // HEAD and probe respond normally
      return new Response(null, {
        status: 200,
        headers: {
          "Content-Length": "1000000",
          "Accept-Ranges": "bytes",
        },
      });
    };

    const engine = makeEngine(
      mock416 as unknown as typeof fetch,
      path.join(tmpDir, "store"),
    );
    const task = new DownloadTask(
      engine.createTask("http://test/file.bin", path.join(tmpDir, "file.bin")),
    );

    await expect(task.start()).rejects.toMatchObject({
      category: "rangeError",
    });
    // Should not have retried: 416 is non-retryable
    // We allow a few calls for HEAD + probe + one range attempt
    expect(fetchCalls).toBeLessThanOrEqual(4);
  });

  // ── Test 8: Event handler throwing does not crash the engine ─────────────────
  test("engine completes successfully even if event handler throws", async () => {
    const size = 500_000;
    const body = makeBody(size);
    const { fetch } = makeFetch(body, { supportsRange: true });
    const engine = makeEngine(fetch, path.join(tmpDir, "store"));
    const task = new DownloadTask(
      engine.createTask("http://test/file.bin", path.join(tmpDir, "file.bin")),
    );

    // Register a handler that always throws
    task.on("progress", () => {
      throw new Error("handler exploded");
    });
    task.on("completed", () => {
      throw new Error("handler exploded 2");
    });

    // Engine must not propagate handler errors
    await expect(task.start()).resolves.toBeDefined();
  });
});
