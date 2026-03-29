/**
 * HttpAdapter unit tests.
 *
 * All lifecycle functions are replaced with jest.fn() so no real HTTP calls
 * are made. Tests verify that the adapter correctly delegates to each callback
 * and returns / throws the expected values.
 */
import { HttpAdapter, createHttpAdapter } from "../src/index";
import type { HttpAdapterOptions } from "../src/index";
import type { TransferSession } from "@transferx/core";
import { makeChunkMeta } from "@transferx/core";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSession(
  overrides: Partial<TransferSession> = {},
): TransferSession {
  return {
    id: "sess-http-1",
    direction: "upload",
    file: {
      name: "data.bin",
      size: 8 * 1024 * 1024,
      mimeType: "application/octet-stream",
    },
    targetKey: "uploads/data.bin",
    chunkSize: 4 * 1024 * 1024,
    state: "initializing",
    chunks: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    transferredBytes: 0,
    sessionRetries: 0,
    ...overrides,
  };
}

function makeOptions(
  overrides: Partial<HttpAdapterOptions> = {},
): HttpAdapterOptions {
  return {
    initFn: jest.fn().mockResolvedValue("upload-id-42"),
    uploadFn: jest.fn().mockResolvedValue("etag-abc"),
    completeFn: jest.fn().mockResolvedValue(undefined),
    abortFn: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ── initTransfer ──────────────────────────────────────────────────────────────

describe("HttpAdapter.initTransfer", () => {
  it("delegates to initFn and returns the provider session id", async () => {
    const opts = makeOptions();
    const adapter = new HttpAdapter(opts);
    const result = await adapter.initTransfer(makeSession());
    expect(result).toBe("upload-id-42");
    expect(opts.initFn).toHaveBeenCalledTimes(1);
  });

  it("passes the session to initFn", async () => {
    const opts = makeOptions();
    const adapter = new HttpAdapter(opts);
    const session = makeSession({ id: "sess-check" });
    await adapter.initTransfer(session);
    expect(opts.initFn).toHaveBeenCalledWith(session);
  });

  it("propagates rejections from initFn", async () => {
    const opts = makeOptions({
      initFn: jest.fn().mockRejectedValue(new Error("network down")),
    });
    const adapter = new HttpAdapter(opts);
    await expect(adapter.initTransfer(makeSession())).rejects.toThrow(
      "network down",
    );
  });
});

// ── uploadChunk ───────────────────────────────────────────────────────────────

describe("HttpAdapter.uploadChunk", () => {
  it("delegates to uploadFn and wraps the result as ChunkUploadResult", async () => {
    const opts = makeOptions();
    const adapter = new HttpAdapter(opts);
    const session = makeSession({ providerSessionId: "upload-id-42" });
    const chunk = makeChunkMeta(0, 0, 4 * 1024 * 1024);
    const data = new Uint8Array(10);
    const sha = "deadbeef";

    const result = await adapter.uploadChunk(session, chunk, data, sha);
    expect(result).toEqual({ providerToken: "etag-abc" });
    expect(opts.uploadFn).toHaveBeenCalledWith(session, chunk, data, sha);
  });

  it("propagates rejections from uploadFn", async () => {
    const opts = makeOptions({
      uploadFn: jest.fn().mockRejectedValue(new Error("upload failed")),
    });
    const adapter = new HttpAdapter(opts);
    const chunk = makeChunkMeta(0, 0, 1024);
    await expect(
      adapter.uploadChunk(makeSession(), chunk, new Uint8Array(1), ""),
    ).rejects.toThrow("upload failed");
  });
});

// ── completeTransfer ──────────────────────────────────────────────────────────

describe("HttpAdapter.completeTransfer", () => {
  it("delegates to completeFn with session and chunks", async () => {
    const opts = makeOptions();
    const adapter = new HttpAdapter(opts);
    const session = makeSession({ providerSessionId: "upload-id-42" });
    const chunks = [makeChunkMeta(0, 0, 1024), makeChunkMeta(1, 1024, 1024)];

    await adapter.completeTransfer(session, chunks);
    expect(opts.completeFn).toHaveBeenCalledWith(session, chunks);
  });

  it("propagates rejections from completeFn", async () => {
    const opts = makeOptions({
      completeFn: jest.fn().mockRejectedValue(new Error("complete failed")),
    });
    const adapter = new HttpAdapter(opts);
    await expect(adapter.completeTransfer(makeSession(), [])).rejects.toThrow(
      "complete failed",
    );
  });
});

// ── abortTransfer ─────────────────────────────────────────────────────────────

describe("HttpAdapter.abortTransfer", () => {
  it("delegates to abortFn when provided", async () => {
    const opts = makeOptions();
    const adapter = new HttpAdapter(opts);
    const session = makeSession({ providerSessionId: "upload-id-42" });
    await adapter.abortTransfer(session);
    expect(opts.abortFn).toHaveBeenCalledWith(session);
  });

  it("is a no-op when abortFn is not provided", async () => {
    const { abortFn: _omit, ...rest } = makeOptions();
    const adapter = new HttpAdapter(rest as HttpAdapterOptions);
    // Should not throw
    await expect(adapter.abortTransfer(makeSession())).resolves.toBeUndefined();
  });

  it("swallows errors from abortFn (best-effort)", async () => {
    const opts = makeOptions({
      abortFn: jest.fn().mockRejectedValue(new Error("already gone")),
    });
    const adapter = new HttpAdapter(opts);
    // Must resolve without throwing
    await expect(adapter.abortTransfer(makeSession())).resolves.toBeUndefined();
  });
});

// ── getRemoteState ────────────────────────────────────────────────────────────

describe("HttpAdapter.getRemoteState", () => {
  it("delegates to getRemoteStateFn when provided", async () => {
    const state = { uploadedParts: [{ partNumber: 1, providerToken: "e1" }] };
    const opts = makeOptions({
      getRemoteStateFn: jest.fn().mockResolvedValue(state),
    });
    const adapter = new HttpAdapter(opts);
    const result = await adapter.getRemoteState!(makeSession());
    expect(result).toEqual(state);
    expect(opts.getRemoteStateFn).toHaveBeenCalledTimes(1);
  });

  it("throws when getRemoteStateFn is not configured", async () => {
    const opts = makeOptions(); // no getRemoteStateFn
    const adapter = new HttpAdapter(opts);
    await expect(adapter.getRemoteState!(makeSession())).rejects.toThrow(
      /getRemoteStateFn is not configured/,
    );
  });
});

// ── createHttpAdapter factory ─────────────────────────────────────────────────

describe("createHttpAdapter", () => {
  it("returns an HttpAdapter instance", () => {
    const adapter = createHttpAdapter(makeOptions());
    expect(adapter).toBeInstanceOf(HttpAdapter);
  });

  it("the returned adapter delegates correctly", async () => {
    const initFn = jest.fn().mockResolvedValue("factory-session-id");
    const adapter = createHttpAdapter(makeOptions({ initFn }));
    const result = await adapter.initTransfer(makeSession());
    expect(result).toBe("factory-session-id");
  });
});
