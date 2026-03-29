/**
 * @module engine.test
 *
 * Tests for UploadEngine — the main orchestrator.
 *
 * Strategy: all I/O is replaced with in-process fakes.
 *   - ITransferAdapter  → controlled mock (jest.fn())
 *   - ISessionStore     → MemorySessionStore (real, but in-memory)
 *   - IEventBus         → EventBus (real implementation)
 *   - IChunkReader      → ByteArrayReader (in-process Uint8Array slice)
 *
 * We set maxAttempts = 1 in the retry policy for most tests so withRetry()
 * treats the first failure as fatal — this prevents real backoff delays.
 * When testing retry behaviour we set maxAttempts > 1 and patch jest timers.
 */

import { UploadEngine, makeUploadSession } from "../src/engine/UploadEngine.js";
import { EventBus } from "../src/events/EventBus.js";
import { MemorySessionStore } from "../src/store/MemorySessionStore.js";
import { resolveEngineConfig } from "../src/types/config.js";
import type { ITransferAdapter } from "../src/adapter/ITransferAdapter.js";
import type { FileDescriptor, TransferSession } from "../src/types/session.js";
import type { ChunkMeta } from "../src/types/chunk.js";
import type { IChunkReader } from "../src/chunker/Chunker.js";
import type { TransferEvent } from "../src/types/events.js";
import { networkError, serverError } from "../src/types/errors.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** A chunk reader backed by a Uint8Array — no filesystem needed. */
class ByteArrayReader implements IChunkReader {
  constructor(private readonly data: Uint8Array) {}
  async read(offset: number, size: number): Promise<Uint8Array> {
    return this.data.slice(offset, offset + size);
  }
  async close(): Promise<void> {}
}

/** Build a file descriptor for a buffer of a given size. */
function makeFile(size: number): { file: FileDescriptor; data: Uint8Array } {
  const data = new Uint8Array(size).fill(0xab);
  const file: FileDescriptor = {
    name: "test.bin",
    size,
    mimeType: "application/octet-stream",
  };
  return { file, data };
}

/** Build a fresh adapter mock with all methods resolving by default. */
function makeAdapter(): jest.Mocked<ITransferAdapter> {
  return {
    initTransfer: jest.fn().mockResolvedValue("provider-session-1"),
    uploadChunk: jest
      .fn()
      .mockResolvedValue({ providerToken: "sha1-token-stub" }),
    completeTransfer: jest.fn().mockResolvedValue(undefined),
    abortTransfer: jest.fn().mockResolvedValue(undefined),
  };
}

/** Build an engine with minimal retry (1 attempt) to avoid slow backoff delays. */
function makeEngine(
  adapter: ITransferAdapter,
  store: MemorySessionStore,
  bus: EventBus,
  data: Uint8Array,
  chunkSize = 512,
) {
  return new UploadEngine({
    adapter,
    store,
    bus,
    config: {
      chunkSize,
      progressIntervalMs: 0, // emit every tick in tests
      retry: {
        maxAttempts: 1,
        baseDelayMs: 0,
        maxDelayMs: 0,
        jitterMs: 0,
      },
    },
    readerFactory: () => new ByteArrayReader(data),
  });
}

/** Collect all events of a given type during an action. */
function captureEvents(
  bus: EventBus,
  type: TransferEvent["type"],
): TransferEvent[] {
  const captured: TransferEvent[] = [];
  bus.on(type as "session:done", (e) => captured.push(e));
  return captured;
}

// ── Test fixtures ─────────────────────────────────────────────────────────────

function makeSession(
  file: FileDescriptor,
  config = resolveEngineConfig({ chunkSize: 512 }),
): TransferSession {
  return makeUploadSession("sess-1", file, "uploads/test.bin", config);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("UploadEngine — happy path", () => {
  test("uploads all chunks and transitions session to done", async () => {
    const { file, data } = makeFile(1024);
    const adapter = makeAdapter();
    const store = new MemorySessionStore();
    const bus = new EventBus();

    const doneFired: TransferEvent[] = [];
    bus.on("session:done", (e) => doneFired.push(e));

    const engine = makeEngine(adapter, store, bus, data);
    const session = makeSession(file);
    await store.save(session);

    const result = await engine.upload(session);

    expect(result.state).toBe("done");
    expect(doneFired).toHaveLength(1);
  });

  test("session stored in 'done' state after upload completes", async () => {
    const { file, data } = makeFile(1024);
    const adapter = makeAdapter();
    const store = new MemorySessionStore();
    const bus = new EventBus();

    const engine = makeEngine(adapter, store, bus, data);
    const session = makeSession(file);
    await store.save(session);

    await engine.upload(session);

    const persisted = await store.load(session.id);
    expect(persisted?.state).toBe("done");
  });

  test("calls adapter lifecycle methods in correct order", async () => {
    const { file, data } = makeFile(512);
    const adapter = makeAdapter();
    const store = new MemorySessionStore();
    const bus = new EventBus();

    const calls: string[] = [];
    adapter.initTransfer.mockImplementation(async () => {
      calls.push("init");
      return "prov-sess";
    });
    adapter.uploadChunk.mockImplementation(async () => {
      calls.push("upload");
      return { providerToken: "tok" };
    });
    adapter.completeTransfer.mockImplementation(async () => {
      calls.push("complete");
    });

    const engine = makeEngine(adapter, store, bus, data);
    const session = makeSession(file);
    await store.save(session);

    await engine.upload(session);

    expect(calls).toEqual(["init", "upload", "complete"]);
  });

  test("chunk.providerToken is set from adapter result", async () => {
    const { file, data } = makeFile(512);
    const adapter = makeAdapter();
    adapter.uploadChunk.mockResolvedValue({ providerToken: "sha1-abc123" });
    const store = new MemorySessionStore();
    const bus = new EventBus();

    const engine = makeEngine(adapter, store, bus, data);
    const session = makeSession(file);
    await store.save(session);

    const result = await engine.upload(session);

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]!.providerToken).toBe("sha1-abc123");
  });

  test("transferredBytes equals total file size after upload", async () => {
    const { file, data } = makeFile(1000);
    const adapter = makeAdapter();
    const store = new MemorySessionStore();
    const bus = new EventBus();

    const engine = makeEngine(adapter, store, bus, data, 300);
    const session = makeUploadSession(
      "sess-1",
      file,
      "uploads/test.bin",
      resolveEngineConfig({ chunkSize: 300 }),
    );
    await store.save(session);

    const result = await engine.upload(session);

    expect(result.transferredBytes).toBe(1000);
  });

  test("emits chunk:done events for each chunk", async () => {
    const { file, data } = makeFile(1024);
    const adapter = makeAdapter();
    const store = new MemorySessionStore();
    const bus = new EventBus();

    const chunkDone: ChunkMeta[] = [];
    bus.on("chunk:done", (e) => chunkDone.push(e.chunk));

    const engine = makeEngine(adapter, store, bus, data, 512);
    const session = makeSession(file);
    await store.save(session);

    await engine.upload(session);

    // 1024 / 512 = 2 chunks
    expect(chunkDone).toHaveLength(2);
    expect(chunkDone.every((c) => c.status === "done")).toBe(true);
  });

  test("emits session:started event", async () => {
    const { file, data } = makeFile(512);
    const adapter = makeAdapter();
    const store = new MemorySessionStore();
    const bus = new EventBus();

    const started = captureEvents(bus, "session:started");

    const engine = makeEngine(adapter, store, bus, data);
    const session = makeSession(file);
    await store.save(session);

    await engine.upload(session);

    expect(started).toHaveLength(1);
  });

  test("passes sha256 hex to adapter.uploadChunk", async () => {
    const { file, data } = makeFile(512);
    const adapter = makeAdapter();
    const store = new MemorySessionStore();
    const bus = new EventBus();

    const engine = makeEngine(adapter, store, bus, data);
    const session = makeSession(file);
    await store.save(session);

    await engine.upload(session);

    const [, , , sha256Hex] = adapter.uploadChunk.mock.calls[0]!;
    expect(typeof sha256Hex).toBe("string");
    expect(sha256Hex).toHaveLength(64); // hex-encoded SHA-256 = 32 bytes = 64 hex chars
  });
});

describe("UploadEngine — failure handling", () => {
  test("session transitions to failed when a chunk is fatally exhausted", async () => {
    const { file, data } = makeFile(512);
    const adapter = makeAdapter();
    adapter.uploadChunk.mockRejectedValue(
      networkError("simulated network failure"),
    );

    const store = new MemorySessionStore();
    const bus = new EventBus();

    const engine = makeEngine(adapter, store, bus, data);
    const session = makeSession(file);
    await store.save(session);

    const result = await engine.upload(session);

    expect(result.state).toBe("failed");
  });

  test("emits session:failed event on fatal chunk failure", async () => {
    const { file, data } = makeFile(512);
    const adapter = makeAdapter();
    adapter.uploadChunk.mockRejectedValue(networkError("network error"));

    const store = new MemorySessionStore();
    const bus = new EventBus();

    const failed: TransferEvent[] = [];
    bus.on("session:failed", (e) => failed.push(e));

    const engine = makeEngine(adapter, store, bus, data);
    const session = makeSession(file);
    await store.save(session);

    await engine.upload(session);

    expect(failed).toHaveLength(1);
  });

  test("emits chunk:fatal event for an exhausted chunk", async () => {
    const { file, data } = makeFile(512);
    const adapter = makeAdapter();
    adapter.uploadChunk.mockRejectedValue(networkError("fail"));

    const store = new MemorySessionStore();
    const bus = new EventBus();

    const fatalChunks: ChunkMeta[] = [];
    bus.on("chunk:fatal", (e) => fatalChunks.push(e.chunk));

    const engine = makeEngine(adapter, store, bus, data);
    const session = makeSession(file);
    await store.save(session);

    await engine.upload(session);

    expect(fatalChunks).toHaveLength(1);
    expect(fatalChunks[0]!.status).toBe("fatal");
  });

  test("calls abortTransfer after session failure", async () => {
    const { file, data } = makeFile(512);
    const adapter = makeAdapter();
    adapter.uploadChunk.mockRejectedValue(networkError("fail"));

    const store = new MemorySessionStore();
    const bus = new EventBus();

    const engine = makeEngine(adapter, store, bus, data);
    const session = makeSession(file);
    await store.save(session);

    await engine.upload(session);

    expect(adapter.abortTransfer).toHaveBeenCalledTimes(1);
  });

  test("session transitions to failed when initTransfer rejects", async () => {
    const { file, data } = makeFile(512);
    const adapter = makeAdapter();
    adapter.initTransfer.mockRejectedValue(serverError(500, "internal error"));

    const store = new MemorySessionStore();
    const bus = new EventBus();

    const engine = makeEngine(adapter, store, bus, data);
    const session = makeSession(file);
    await store.save(session);

    const result = await engine.upload(session);

    expect(result.state).toBe("failed");
    expect(adapter.uploadChunk).not.toHaveBeenCalled();
  });

  test("session transitions to failed when completeTransfer rejects", async () => {
    const { file, data } = makeFile(512);
    const adapter = makeAdapter();
    adapter.completeTransfer.mockRejectedValue(
      serverError(500, "complete failed"),
    );

    const store = new MemorySessionStore();
    const bus = new EventBus();

    const engine = makeEngine(adapter, store, bus, data);
    const session = makeSession(file);
    await store.save(session);

    const result = await engine.upload(session);

    expect(result.state).toBe("failed");
    expect(adapter.abortTransfer).toHaveBeenCalledTimes(1);
  });
});

describe("UploadEngine — retry behaviour", () => {
  test("chunk succeeds after one retryable failure when maxAttempts >= 2", async () => {
    const { file, data } = makeFile(512);
    const adapter = makeAdapter();

    // First call fails, second succeeds
    let callCount = 0;
    adapter.uploadChunk.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw networkError("transient failure");
      return { providerToken: "tok" };
    });

    const store = new MemorySessionStore();
    const bus = new EventBus();

    const engine = new UploadEngine({
      adapter,
      store,
      bus,
      config: {
        chunkSize: 512,
        progressIntervalMs: 0,
        retry: {
          maxAttempts: 3,
          baseDelayMs: 0,
          maxDelayMs: 0,
          jitterMs: 0,
        },
      },
      readerFactory: () => new ByteArrayReader(data),
    });

    const session = makeSession(file);
    await store.save(session);

    const result = await engine.upload(session);

    expect(result.state).toBe("done");
    expect(callCount).toBe(2);
  });

  test("emits chunk:failed with willRetry=true for retryable failure", async () => {
    const { file, data } = makeFile(512);
    const adapter = makeAdapter();

    let callCount = 0;
    adapter.uploadChunk.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw networkError("transient");
      return { providerToken: "tok" };
    });

    const store = new MemorySessionStore();
    const bus = new EventBus();

    const chunkFailed: Array<{ willRetry: boolean }> = [];
    bus.on("chunk:failed", (e) => chunkFailed.push({ willRetry: e.willRetry }));

    const engine = new UploadEngine({
      adapter,
      store,
      bus,
      config: {
        chunkSize: 512,
        progressIntervalMs: 0,
        retry: {
          maxAttempts: 3,
          baseDelayMs: 0,
          maxDelayMs: 0,
          jitterMs: 0,
        },
      },
      readerFactory: () => new ByteArrayReader(data),
    });

    const session = makeSession(file);
    await store.save(session);

    await engine.upload(session);

    expect(chunkFailed).toHaveLength(1);
    expect(chunkFailed[0]!.willRetry).toBe(true);
  });
});

describe("UploadEngine — multiple chunks", () => {
  test("uploads 4 chunks for a 2048-byte file with 512-byte chunks", async () => {
    const { file, data } = makeFile(2048);
    const adapter = makeAdapter();
    const store = new MemorySessionStore();
    const bus = new EventBus();

    const engine = makeEngine(adapter, store, bus, data, 512);
    const session = makeUploadSession(
      "sess-multi",
      file,
      "uploads/large.bin",
      resolveEngineConfig({ chunkSize: 512 }),
    );
    await store.save(session);

    const result = await engine.upload(session);

    expect(result.state).toBe("done");
    expect(adapter.uploadChunk).toHaveBeenCalledTimes(4);
    expect(result.chunks).toHaveLength(4);
    expect(result.chunks.every((c) => c.status === "done")).toBe(true);
  });

  test("completeTransfer receives all chunks with providerTokens set", async () => {
    const { file, data } = makeFile(1024);
    const adapter = makeAdapter();
    let counter = 0;
    adapter.uploadChunk.mockImplementation(async () => ({
      providerToken: `tok-${++counter}`,
    }));
    const store = new MemorySessionStore();
    const bus = new EventBus();

    const engine = makeEngine(adapter, store, bus, data, 512);
    const session = makeSession(file);
    await store.save(session);

    await engine.upload(session);

    const [, completedChunks] = adapter.completeTransfer.mock.calls[0]!;
    expect(completedChunks).toHaveLength(2);
    expect(completedChunks.every((c: ChunkMeta) => !!c.providerToken)).toBe(
      true,
    );
  });
});

describe("UploadEngine — EventBus", () => {
  test("emits events in lifecycle order", async () => {
    const { file, data } = makeFile(512);
    const adapter = makeAdapter();
    const store = new MemorySessionStore();
    const bus = new EventBus();

    const eventTypes: string[] = [];
    bus.on("session:created", () => eventTypes.push("session:created"));
    bus.on("session:started", () => eventTypes.push("session:started"));
    bus.on("chunk:started", () => eventTypes.push("chunk:started"));
    bus.on("chunk:done", () => eventTypes.push("chunk:done"));
    bus.on("session:done", () => eventTypes.push("session:done"));

    const engine = makeEngine(adapter, store, bus, data);
    const session = makeSession(file);
    await store.save(session);

    await engine.upload(session);

    expect(eventTypes).toEqual([
      "session:created",
      "session:started",
      "chunk:started",
      "chunk:done",
      "session:done",
    ]);
  });
});

describe("UploadEngine — pause/resume", () => {
  test("pause() is a no-op when no upload is in progress", () => {
    const adapter = makeAdapter();
    const store = new MemorySessionStore();
    const bus = new EventBus();

    const engine = new UploadEngine({
      adapter,
      store,
      bus,
      readerFactory: () => ({
        read: async () => new Uint8Array(0),
        close: async () => {},
      }),
    });

    // Should not throw
    expect(() => engine.pause("nonexistent")).not.toThrow();
    expect(() => engine.resumeScheduler("nonexistent")).not.toThrow();
  });
});

// ── checksumVerify flag ────────────────────────────────────────────────────────
describe("UploadEngine — checksumVerify: false", () => {
  test("skips SHA-256 computation and passes empty string to adapter", async () => {
    const { file, data } = makeFile(512);
    const adapter = makeAdapter();
    const sha256Received: string[] = [];
    adapter.uploadChunk.mockImplementation(
      async (
        _s: TransferSession,
        _c: ChunkMeta,
        _d: Uint8Array,
        sha256: string,
      ) => {
        sha256Received.push(sha256);
        return { providerToken: "tok" };
      },
    );

    const store = new MemorySessionStore();
    const bus = new EventBus();
    const engine = new UploadEngine({
      adapter,
      store,
      bus,
      config: {
        chunkSize: 512,
        checksumVerify: false,
        progressIntervalMs: 0,
        retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, jitterMs: 0 },
      },
      readerFactory: () => new ByteArrayReader(data),
    });

    const session = makeSession(file);
    await store.save(session);
    await engine.upload(session);

    // Adapter received empty string — no SHA-256 was computed
    expect(sha256Received.every((s) => s === "")).toBe(true);
  });

  test("checksumVerify: true (default) sends a non-empty SHA-256", async () => {
    const { file, data } = makeFile(512);
    const adapter = makeAdapter();
    const sha256Received: string[] = [];
    adapter.uploadChunk.mockImplementation(
      async (
        _s: TransferSession,
        _c: ChunkMeta,
        _d: Uint8Array,
        sha256: string,
      ) => {
        sha256Received.push(sha256);
        return { providerToken: "tok" };
      },
    );

    const store = new MemorySessionStore();
    const bus = new EventBus();
    const engine = new UploadEngine({
      adapter,
      store,
      bus,
      config: {
        chunkSize: 512,
        checksumVerify: true,
        progressIntervalMs: 0,
        retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, jitterMs: 0 },
      },
      readerFactory: () => new ByteArrayReader(data),
    });

    const session = makeSession(file);
    await store.save(session);
    await engine.upload(session);

    // All chunks should have a 64-char hex SHA-256
    expect(sha256Received.every((s) => /^[0-9a-f]{64}$/.test(s))).toBe(true);
  });
});

// ── EventBus handler isolation (end-to-end engine test) ────────────────────────
describe("UploadEngine — EventBus handler isolation", () => {
  test("session reaches 'done' even if a chunk:done handler throws", async () => {
    const { file, data } = makeFile(512);
    const adapter = makeAdapter();
    const store = new MemorySessionStore();
    const bus = new EventBus();

    // Register a handler that throws on every chunk:done event
    bus.on("chunk:done", () => {
      throw new Error("deliberate handler crash");
    });

    const logEvents: TransferEvent[] = [];
    bus.on("log", (e) => logEvents.push(e));

    const engine = makeEngine(adapter, store, bus, data);
    const session = makeSession(file);
    await store.save(session);
    const result = await engine.upload(session);

    // Session should still complete successfully
    expect(result.state).toBe("done");
    // The EventBus should have emitted at least one log:error for the throwing handler
    const errorLogs = logEvents.filter(
      (e) => e.type === "log" && (e as { level: string }).level === "error",
    );
    expect(errorLogs.length).toBeGreaterThan(0);
  });

  test("session reaches 'done' even if session:done handler throws", async () => {
    const { file, data } = makeFile(512);
    const adapter = makeAdapter();
    const store = new MemorySessionStore();
    const bus = new EventBus();

    bus.on("session:done", () => {
      throw new Error("session:done handler crash");
    });

    const engine = makeEngine(adapter, store, bus, data);
    const session = makeSession(file);
    await store.save(session);

    // Must not throw — handler error is isolated by EventBus
    await expect(engine.upload(session)).resolves.toMatchObject({
      state: "done",
    });
  });
});

// ── Log events ─────────────────────────────────────────────────────────────────
describe("UploadEngine — log events", () => {
  test("emits log:warn for each retryable chunk failure", async () => {
    const { file, data } = makeFile(512);
    const adapter = makeAdapter();

    let calls = 0;
    adapter.uploadChunk.mockImplementation(async () => {
      calls++;
      if (calls === 1) throw networkError("transient");
      return { providerToken: "tok" };
    });

    const store = new MemorySessionStore();
    const bus = new EventBus();
    const logEvents: TransferEvent[] = [];
    bus.on("log", (e) => logEvents.push(e));

    const engine = new UploadEngine({
      adapter,
      store,
      bus,
      config: {
        chunkSize: 512,
        progressIntervalMs: 0,
        retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, jitterMs: 0 },
      },
      readerFactory: () => new ByteArrayReader(data),
    });

    const session = makeSession(file);
    await store.save(session);
    await engine.upload(session);

    const warnLogs = logEvents.filter(
      (e) => e.type === "log" && (e as { level: string }).level === "warn",
    );
    expect(warnLogs.length).toBeGreaterThanOrEqual(1);
  });

  test("emits log:info on successful session completion", async () => {
    const { file, data } = makeFile(512);
    const adapter = makeAdapter();
    const store = new MemorySessionStore();
    const bus = new EventBus();
    const logEvents: TransferEvent[] = [];
    bus.on("log", (e) => logEvents.push(e));

    const engine = makeEngine(adapter, store, bus, data);
    const session = makeSession(file);
    await store.save(session);
    await engine.upload(session);

    const infoLogs = logEvents.filter(
      (e) => e.type === "log" && (e as { level: string }).level === "info",
    );
    expect(infoLogs.length).toBeGreaterThanOrEqual(1);
  });
});
