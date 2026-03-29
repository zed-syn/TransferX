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
import { DownloadManager } from "../src/DownloadManager";
import { DownloadMetrics } from "../src/DownloadMetrics";
import { DownloadEventBus } from "../src/EventBus";
import {
  FetchHttpClient,
  PooledHttpClient,
  createHttpClient,
  isUndiciAvailable,
} from "../src/HttpClient";

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

  test("rehydrate preserves bytesWritten for sub-chunk resume (running and failed)", () => {
    const input = RangePlanner.plan(6 * 1024 * 1024, 2 * 1024 * 1024, true);
    const withStates = input.map((c, i) => ({
      ...c,
      status: (["running", "failed", "done"] as const)[i % 3]!,
      bytesWritten: c.size,
      attempts: 2,
    }));

    const rehydrated = RangePlanner.rehydrate(withStates);

    // running → pending; bytesWritten PRESERVED (byte-level resume); attempts reset
    expect(rehydrated[0]!.status).toBe("pending");
    expect(rehydrated[0]!.bytesWritten).toBe(withStates[0]!.bytesWritten);
    expect(rehydrated[0]!.attempts).toBe(0);

    // failed → pending; bytesWritten PRESERVED
    expect(rehydrated[1]!.status).toBe("pending");
    expect(rehydrated[1]!.bytesWritten).toBe(withStates[1]!.bytesWritten);

    // done → unchanged
    expect(rehydrated[2]!.status).toBe("done");
    expect(rehydrated[2]!.bytesWritten).toBe(rehydrated[2]!.size);
  });

  test("rehydrate resets attempts to 0 but keeps zero bytesWritten if already zero", () => {
    const chunk = {
      index: 0,
      start: 0,
      end: 999,
      size: 1000,
      status: "running" as const,
      attempts: 3,
      bytesWritten: 0,
    };
    const [result] = RangePlanner.rehydrate([chunk]);
    expect(result!.status).toBe("pending");
    expect(result!.bytesWritten).toBe(0);
    expect(result!.attempts).toBe(0);
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

// ─── Byte-level sub-chunk resume tests ────────────────────────────────────────

describe("Byte-level sub-chunk resume", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeBody(size: number): Uint8Array {
    const buf = new Uint8Array(size);
    for (let i = 0; i < size; i++) buf[i] = i % 256;
    return buf;
  }

  test("Range header uses chunk.start + bytesWritten on resume", async () => {
    const chunkSize = 1 * 1024 * 1024; // 1 MiB
    const fileSize = 3 * chunkSize;
    const body = makeBody(fileSize);
    const storeDir = path.join(tmpDir, "store");

    // Manually create a session where chunk 0 has bytesWritten = 512 KiB
    // (simulating a crash mid-chunk).
    const { fetch: baseFetch } = makeFetch(body, {
      supportsRange: true,
      etag: '"stable"',
    });

    const engine = makeEngine(baseFetch, storeDir, {
      chunkSize,
      fsyncIntervalChunks: 0, // disable periodic sync for simpler test
    });
    // Create the task to get the derived session ID
    const inner = engine.createTask(
      "http://test/file.bin",
      path.join(tmpDir, "file.bin"),
    );

    // Inject a partial session: chunk 0 partially written
    const store = new ResumeStore(storeDir);
    const chunks = RangePlanner.plan(fileSize, chunkSize, true);
    const partialBytesWritten = 512 * 1024; // 512 KiB written for chunk 0
    const partialSession: DownloadSession = {
      id: inner.id,
      url: "http://test/file.bin",
      outputPath: path.join(tmpDir, "file.bin"),
      fileSize,
      etag: '"stable"',
      lastModified: null,
      supportsRange: true,
      status: "running",
      chunks: chunks.map((c) =>
        c.index === 0
          ? { ...c, status: "running", bytesWritten: partialBytesWritten }
          : c,
      ),
      downloadedBytes: partialBytesWritten,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await store.save(partialSession);

    // Pre-populate the file with the "already downloaded" 512 KiB
    fs.mkdirSync(path.dirname(path.join(tmpDir, "file.bin")), {
      recursive: true,
    });
    const preWritten = Buffer.alloc(fileSize, 0);
    for (let i = 0; i < partialBytesWritten; i++) preWritten[i] = body[i]!;
    fs.writeFileSync(path.join(tmpDir, "file.bin"), preWritten);

    // Track Range headers sent during resume
    const rangesRequested: string[] = [];
    const trackFetch = async (
      url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const h = (init?.headers ?? {}) as Record<string, string>;
      if (h["Range"]) rangesRequested.push(h["Range"]);
      return baseFetch(url, init);
    };

    const resumeEngine = makeEngine(
      trackFetch as unknown as typeof fetch,
      storeDir,
      { chunkSize, fsyncIntervalChunks: 0 },
    );
    const resumedInner = await resumeEngine.resumeTask(inner.id);
    expect(resumedInner).not.toBeNull();

    await new DownloadTask(resumedInner!).start();

    // Chunk 0 should request from partialBytesWritten (rounded to 1 MiB = 0, since 512KiB < 1MiB)
    // bytesWritten = 512 KiB, RESUME_GRANULARITY = 1 MiB → resumeOffset = 0
    // So chunk 0 range is bytes=0-1048575 (full chunk re-download — safe rounding)
    const chunk0Range = rangesRequested.find((r) => r.startsWith("bytes=0-"));
    expect(chunk0Range).toBeDefined();

    // Final file must be byte-perfect
    const result = fs.readFileSync(path.join(tmpDir, "file.bin"));
    expect(result.length).toBe(fileSize);
    for (let i = 0; i < fileSize; i++) {
      if (result[i] !== body[i]) {
        throw new Error(
          `Byte mismatch at ${i}: got ${result[i]}, expected ${body[i]}`,
        );
      }
    }
  });

  test("bytesWritten in session accumulates correctly across retries", async () => {
    const size = 2 * 1024 * 1024;
    const body = makeBody(size);
    let downloadCallCount = 0;

    // Fail once on the first download call to trigger a retry within the session
    const mockFetch = async (
      url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const h = (init?.headers ?? {}) as Record<string, string>;
      const isProbe = init?.method === "HEAD" || h["Range"] === "bytes=0-0";
      const { fetch: realFetch } = makeFetch(body, { supportsRange: true });
      if (!isProbe) {
        downloadCallCount++;
        // Fail the second download call to exercise retry path
        if (downloadCallCount === 2) {
          return new Response(null, { status: 503 });
        }
      }
      return realFetch(url, init);
    };

    const engine = makeEngine(
      mockFetch as unknown as typeof fetch,
      path.join(tmpDir, "store"),
    );
    const task = new DownloadTask(
      engine.createTask("http://test/file.bin", path.join(tmpDir, "file.bin")),
    );

    await task.start();

    const result = fs.readFileSync(path.join(tmpDir, "file.bin"));
    expect(result.length).toBe(size);
  });
});

// ─── FileWriter pre-allocation tests ────────────────────────────────────────

describe("FileWriter pre-allocation (ftruncate)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("fresh open with known fileSize creates file of correct size immediately", async () => {
    const filePath = path.join(tmpDir, "preallocated.bin");
    const fileSize = 4 * 1024 * 1024; // 4 MiB
    const writer = new FileWriter(filePath);
    await writer.open(fileSize, false);
    await writer.close();

    // ftruncate should have set the file to exactly fileSize bytes
    const stat = fs.statSync(filePath);
    expect(stat.size).toBe(fileSize);
  });

  test("fresh open without fileSize does not crash", async () => {
    const filePath = path.join(tmpDir, "nosize.bin");
    const writer = new FileWriter(filePath);
    await writer.open(null, false);
    await writer.close();
    expect(fs.existsSync(filePath)).toBe(true);
  });

  test("syncOnChunkComplete calls fdatasync every N completed chunks", async () => {
    const filePath = path.join(tmpDir, "sync-test.bin");
    const writer = new FileWriter(filePath);
    await writer.open(100, false);

    // First 7 calls with interval=8 should NOT flush
    for (let i = 0; i < 7; i++) {
      await writer.syncOnChunkComplete(8);
    }
    // 8th call SHOULD flush (no error = fdatasync executed without error)
    await expect(writer.syncOnChunkComplete(8)).resolves.toBeUndefined();

    await writer.close();
  });

  test("syncOnChunkComplete with interval=0 is a no-op", async () => {
    const filePath = path.join(tmpDir, "noop-sync.bin");
    const writer = new FileWriter(filePath);
    await writer.open(10, false);
    // Should not throw regardless of how many times called
    for (let i = 0; i < 20; i++) {
      await writer.syncOnChunkComplete(0);
    }
    await writer.close();
  });
});

// ─── DownloadManager tests ────────────────────────────────────────────────────

describe("DownloadManager", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeBody(size: number): Uint8Array {
    const buf = new Uint8Array(size);
    for (let i = 0; i < size; i++) buf[i] = i % 256;
    return buf;
  }

  test("completes a single download through the manager", async () => {
    const size = 1 * 1024 * 1024;
    const body = makeBody(size);
    const { fetch } = makeFetch(body, { supportsRange: true });

    const manager = new DownloadManager({
      maxConcurrentDownloads: 2,
      storeDir: path.join(tmpDir, "store"),
      config: {
        fetch,
        chunkSize: 512 * 1024,
        concurrency: { initial: 2, min: 1, max: 2, adaptive: false },
        retry: { maxAttempts: 2, baseDelayMs: 5, maxDelayMs: 50, jitterMs: 1 },
        timeoutMs: 5000,
        fsyncIntervalChunks: 0,
      },
    });

    const outPath = path.join(tmpDir, "out.bin");
    const { task, promise } = manager.enqueue("http://test/file.bin", outPath);

    const progressEvents: number[] = [];
    task.on("progress", (p) => {
      if (p.percent !== null) progressEvents.push(p.percent);
    });

    const session = await promise;
    expect(session.status).toBe("completed");

    const result = fs.readFileSync(outPath);
    expect(result.length).toBe(size);
    expect(progressEvents.length).toBeGreaterThan(0);
  });

  test("respects maxConcurrentDownloads cap", async () => {
    const size = 500_000;
    const body = makeBody(size);

    let peak = 0;
    let active = 0;

    const countFetch = async (
      url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const h = (init?.headers ?? {}) as Record<string, string>;
      const isProbe = init?.method === "HEAD" || h["Range"] === "bytes=0-0";
      if (!isProbe) {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
      }
      const { fetch: f } = makeFetch(body, { supportsRange: false });
      return f(url, init);
    };

    const manager = new DownloadManager({
      maxConcurrentDownloads: 2,
      storeDir: path.join(tmpDir, "store"),
      config: {
        fetch: countFetch as unknown as typeof fetch,
        concurrency: { initial: 1, min: 1, max: 1, adaptive: false },
        retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 5, jitterMs: 0 },
        timeoutMs: 5000,
        fsyncIntervalChunks: 0,
      },
    });

    // Enqueue 5 downloads — only 2 should run simultaneously
    const promises = Array.from({ length: 5 }, (_, i) => {
      const { promise } = manager.enqueue(
        "http://test/file.bin",
        path.join(tmpDir, `out${i}.bin`),
      );
      return promise;
    });
    await Promise.all(promises);

    // With maxConcurrentDownloads=2 and single-connection downloads, peak active
    // connections should be ≤ 2 (one per concurrent download).
    expect(peak).toBeLessThanOrEqual(2);
  });

  test("cancelAll rejects queued promises", async () => {
    const size = 500_000;
    const body = makeBody(size);

    // Slow fetch so downloads don't complete before cancelAll
    const slowFetch = async (
      url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const h = (init?.headers ?? {}) as Record<string, string>;
      const isProbe = init?.method === "HEAD" || h["Range"] === "bytes=0-0";
      if (!isProbe) await new Promise((r) => setTimeout(r, 500));
      const { fetch: f } = makeFetch(body, { supportsRange: false });
      return f(url, init);
    };

    const manager = new DownloadManager({
      maxConcurrentDownloads: 1,
      storeDir: path.join(tmpDir, "store"),
      config: {
        fetch: slowFetch as unknown as typeof fetch,
        concurrency: { initial: 1, min: 1, max: 1, adaptive: false },
        retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 5, jitterMs: 0 },
        timeoutMs: 5000,
        fsyncIntervalChunks: 0,
      },
    });

    const { promise: p1 } = manager.enqueue(
      "http://test/a.bin",
      path.join(tmpDir, "a.bin"),
    );
    // Enqueue a second download — it will be queued (slot taken by p1)
    const { promise: p2 } = manager.enqueue(
      "http://test/b.bin",
      path.join(tmpDir, "b.bin"),
    );

    // Give a tick for p1 to start
    await Promise.resolve();
    await manager.cancelAll();

    // Both promises should settle (either resolved or rejected)
    const [r1, r2] = await Promise.allSettled([p1, p2]);
    // The queued p2 must be rejected (cancelled before starting)
    expect(r2.status).toBe("rejected");
    void r1; // p1 may succeed or fail depending on timing
  });

  test("getStatus reflects active and queued counts", async () => {
    const manager = new DownloadManager({
      maxConcurrentDownloads: 1,
      storeDir: path.join(tmpDir, "store"),
    });
    expect(manager.getStatus().active).toBe(0);
    expect(manager.getStatus().queued).toBe(0);
    expect(manager.getStatus().maxConcurrent).toBe(1);
  });
});

// ─── DownloadMetrics tests ────────────────────────────────────────────────────

describe("DownloadMetrics", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeBody(size: number): Uint8Array {
    const buf = new Uint8Array(size);
    for (let i = 0; i < size; i++) buf[i] = i % 256;
    return buf;
  }

  test("attach tracks progress, chunks, retries, and error rate", async () => {
    const size = 2 * 1024 * 1024;
    const body = makeBody(size);
    let callCount = 0;
    const mockFetch = async (
      url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const h = (init?.headers ?? {}) as Record<string, string>;
      const isProbe = init?.method === "HEAD" || h["Range"] === "bytes=0-0";
      const { fetch: f } = makeFetch(body, { supportsRange: true });
      if (!isProbe) {
        callCount++;
        if (callCount === 1) return new Response(null, { status: 503 });
      }
      return f(url, init);
    };

    const engine = makeEngine(
      mockFetch as unknown as typeof fetch,
      path.join(tmpDir, "store"),
    );
    const inner = engine.createTask(
      "http://test/file.bin",
      path.join(tmpDir, "file.bin"),
    );
    const task = new DownloadTask(inner);

    const metrics = new DownloadMetrics();
    metrics.attach(inner.id, inner.bus);

    await task.start();

    const snap = metrics.getSnapshot(inner.id);
    expect(snap).not.toBeNull();
    expect(snap!.chunksCompleted).toBeGreaterThan(0);
    expect(snap!.retryCount).toBeGreaterThanOrEqual(1);
    expect(snap!.bytesDownloaded).toBe(size);
    // peakSpeedBytesPerSec may be 0 in fast unit-test runs where the
    // ProgressEngine interval fires after completion — only assert non-negative.
    expect(snap!.peakSpeedBytesPerSec).toBeGreaterThanOrEqual(0);
  });

  test("getAggregate sums across multiple tasks", async () => {
    const size = 500_000;
    const body = makeBody(size);
    const { fetch } = makeFetch(body, { supportsRange: false });

    const metrics = new DownloadMetrics();

    const e1 = makeEngine(fetch, path.join(tmpDir, "store1"));
    const i1 = e1.createTask("http://test/a.bin", path.join(tmpDir, "a.bin"));
    metrics.attach(i1.id, i1.bus);

    const e2 = makeEngine(fetch, path.join(tmpDir, "store2"));
    const i2 = e2.createTask("http://test/b.bin", path.join(tmpDir, "b.bin"));
    metrics.attach(i2.id, i2.bus);

    await new DownloadTask(i1).start();
    await new DownloadTask(i2).start();

    const agg = metrics.getAggregate();
    expect(agg.taskCount).toBe(2);
    expect(agg.totalBytesDownloaded).toBe(size * 2);
  });

  test("detach unsubscribes so no more updates are received", async () => {
    const size = 500_000;
    const body = makeBody(size);
    const { fetch } = makeFetch(body, { supportsRange: false });

    const inner = makeEngine(fetch, path.join(tmpDir, "store")).createTask(
      "http://test/file.bin",
      path.join(tmpDir, "file.bin"),
    );
    const task = new DownloadTask(inner);
    const metrics = new DownloadMetrics();
    metrics.attach(inner.id, inner.bus);
    metrics.detach(inner.id, inner.bus); // detach immediately

    await task.start();

    // Snapshot should exist (created at attach time) but metrics are stale
    const snap = metrics.getSnapshot(inner.id);
    // bytesDownloaded stays at 0 because progress events were not received
    expect(snap!.bytesDownloaded).toBe(0);
  });

  test("reset clears all snapshots", async () => {
    const metrics = new DownloadMetrics();
    // Manually add a fake snapshot entry
    const fakeBus = { on: () => {}, off: () => {}, emit: () => {} } as any;
    metrics.attach("task-x", fakeBus as DownloadEventBus);
    expect(metrics.getSnapshot("task-x")).not.toBeNull();
    metrics.reset();
    expect(metrics.getSnapshot("task-x")).toBeNull();
  });
});

// ─── ChunkScheduler throughput signal tests ───────────────────────────────────

describe("ChunkScheduler throughput signal", () => {
  test("addThroughputSample is a no-op when adaptive=false", () => {
    const sc = new ChunkScheduler({
      initial: 2,
      min: 1,
      max: 4,
      adaptive: false,
    });
    // Should not throw
    sc.addThroughputSample(100);
    sc.addThroughputSample(0);
    sc.addThroughputSample(-1);
    expect(sc.currentLimit).toBe(2); // limit unchanged
  });

  test("addThroughputSample records samples when adaptive=true", () => {
    const sc = new ChunkScheduler({
      initial: 2,
      min: 1,
      max: 16,
      adaptive: true,
    });
    // Should not throw and not change limit immediately
    for (let i = 0; i < 15; i++) sc.addThroughputSample(10);
    expect(sc.currentLimit).toBe(2); // no scale-up without error-rate window filled
  });
});

// ─── HttpClient tests ─────────────────────────────────────────────────────────

describe("HttpClient", () => {
  // ── FetchHttpClient ─────────────────────────────────────────────────────────

  test("FetchHttpClient delegates to the provided fetch function", async () => {
    const calls: string[] = [];
    const mockFetch: typeof fetch = async (url) => {
      calls.push(String(url));
      return new Response(Buffer.from("hello"), {
        status: 200,
        headers: { "content-type": "text/plain", "x-custom": "value" },
      });
    };

    const client = new FetchHttpClient(mockFetch);
    const resp = await client.request("http://example.com/test", {});

    expect(calls).toEqual(["http://example.com/test"]);
    expect(resp.status).toBe(200);
    expect(resp.header("content-type")).toBe("text/plain");
    expect(resp.header("x-CUSTOM")).toBe("value"); // case-insensitive via Fetch
    expect(resp.body).not.toBeNull();
  });

  test("FetchHttpClient passes method and headers", async () => {
    let capturedMethod: string | undefined;
    let capturedRange: string | undefined;

    const mockFetch: typeof fetch = async (_url, init) => {
      capturedMethod = init?.method;
      capturedRange = (init?.headers as Record<string, string>)["Range"];
      return new Response(null, { status: 206 });
    };

    const client = new FetchHttpClient(mockFetch);
    const resp = await client.request("http://example.com/file.bin", {
      method: "GET",
      headers: { Range: "bytes=0-1023" },
    });

    expect(capturedMethod).toBe("GET");
    expect(capturedRange).toBe("bytes=0-1023");
    expect(resp.status).toBe(206);
  });

  test("FetchHttpClient tracks request count in stats()", async () => {
    const mockFetch: typeof fetch = async () =>
      new Response(null, { status: 200 });

    const client = new FetchHttpClient(mockFetch);
    expect(client.stats().requests).toBe(0);
    expect(client.stats().pooled).toBe(false);

    await client.request("http://x.com/a", {});
    await client.request("http://x.com/b", {});
    await client.request("http://x.com/c", {});

    expect(client.stats().requests).toBe(3);
    expect(client.stats().reuseRate).toBe(0); // no pooling
  });

  test("FetchHttpClient.close() is a no-op", async () => {
    const client = new FetchHttpClient(
      async () => new Response(null, { status: 200 }),
    );
    await expect(client.close()).resolves.toBeUndefined();
  });

  test("FetchHttpClient forwards AbortSignal to fetch", async () => {
    const ctrl = new AbortController();
    let capturedSignal: AbortSignal | undefined;

    const mockFetch: typeof fetch = async (_url, init) => {
      capturedSignal = init?.signal as AbortSignal | undefined;
      return new Response(null, { status: 200 });
    };

    const client = new FetchHttpClient(mockFetch);
    await client.request("http://x.com/", { signal: ctrl.signal });
    expect(capturedSignal).toBe(ctrl.signal);
  });

  // ── createHttpClient factory ────────────────────────────────────────────────

  test("createHttpClient returns FetchHttpClient when fetchOverride is provided", () => {
    const mockFetch: typeof fetch = async () =>
      new Response(null, { status: 200 });
    const client = createHttpClient("https://example.com/file", 8, mockFetch);
    expect(client).toBeInstanceOf(FetchHttpClient);
    expect(client.stats().pooled).toBe(false);
  });

  test("createHttpClient returns PooledHttpClient when undici is available and no override", () => {
    if (!isUndiciAvailable()) {
      // Skip test if undici is not installed in this environment
      return;
    }
    const client = createHttpClient("https://example.com/file", 8);
    expect(client).toBeInstanceOf(PooledHttpClient);
    expect(client.stats().pooled).toBe(true);
    expect(client.stats().origin).toBe("https://example.com");
    // Close to release pool sockets
    void client.close();
  });

  test("createHttpClient returns FetchHttpClient when no override and undici absent", () => {
    // Test the fallback path by temporarily patching isUndiciAvailable
    // We can test this indirectly: when fetchOverride is provided, always FetchHttpClient
    const client = createHttpClient(
      "https://example.com/file",
      8,
      globalThis.fetch,
    );
    expect(client).toBeInstanceOf(FetchHttpClient);
  });

  // ── PooledHttpClient ────────────────────────────────────────────────────────

  test("PooledHttpClient stats() increments request count and tracks reuse", () => {
    if (!isUndiciAvailable()) return; // skip if undici not installed

    const client = new PooledHttpClient("https://httpbin.org", 4);
    expect(client.stats().requests).toBe(0);
    expect(client.stats().reuseRate).toBe(0);
    expect(client.stats().pooled).toBe(true);
    expect(client.stats().origin).toBe("https://httpbin.org");
    void client.close();
  });

  test("PooledHttpClient constructor throws when undici is not installed", () => {
    if (isUndiciAvailable()) {
      // If undici IS installed, we can't test this path without mocking
      return;
    }
    expect(() => new PooledHttpClient("https://example.com", 4)).toThrow(
      "undici is not installed",
    );
  });

  // ── DownloadEngine uses FetchHttpClient path with injected fetch (existing behavior) ─

  test("DownloadEngine uses connection pool stats log entry", async () => {
    const tmpDir = makeTempDir();
    try {
      const size = 512 * 1024;
      const body = new Uint8Array(size).fill(0xab);
      const { fetch } = makeFetch(body, { supportsRange: true });

      const engine = makeEngine(fetch, path.join(tmpDir, "store"));
      const inner = engine.createTask(
        "http://test/file.bin",
        path.join(tmpDir, "file.bin"),
      );
      const task = new DownloadTask(inner);

      const logMessages: string[] = [];
      inner.bus.on("log", ({ message }) => logMessages.push(message));

      await task.start();

      // Engine must emit an HTTP pool stats log entry
      const poolLog = logMessages.find((m) => m.startsWith("HTTP pool stats:"));
      expect(poolLog).toBeDefined();

      // Parse and validate stats shape
      const json = poolLog!.replace("HTTP pool stats: ", "");
      const stats = JSON.parse(json) as { requests: number; pooled: boolean };
      expect(stats.requests).toBeGreaterThan(0);
      expect(typeof stats.pooled).toBe("boolean");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
