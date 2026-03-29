import {
  transitionSession,
  getTransferredBytes,
  getProgressPercent,
  hasFatalChunks,
  allChunksDone,
  TERMINAL_STATES,
  RESUMABLE_STATES,
} from "../src/types/session";
import type { TransferSession, SessionState } from "../src/types/session";
import { makeChunkMeta } from "../src/types/chunk";

// ── Fixture ──────────────────────────────────────────────────────────────────
function makeSession(
  overrides: Partial<TransferSession> = {},
): TransferSession {
  return {
    id: "test-session",
    direction: "upload",
    file: {
      name: "file.bin",
      size: 30 * 1024 * 1024,
      mimeType: "application/octet-stream",
    },
    chunkSize: 10 * 1024 * 1024,
    state: "created",
    chunks: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    transferredBytes: 0,
    targetKey: "uploads/file.bin",
    sessionRetries: 0,
    ...overrides,
  };
}

// ── transitionSession (mutates in-place, returns void) ────────────────────────
describe("transitionSession", () => {
  it("transitions created to initializing", () => {
    const s = makeSession();
    transitionSession(s, "initializing");
    expect(s.state).toBe("initializing");
  });

  it("transitions running to paused", () => {
    const s = makeSession({ state: "running" });
    transitionSession(s, "paused");
    expect(s.state).toBe("paused");
  });

  it("transitions running to done", () => {
    const s = makeSession({ state: "running" });
    transitionSession(s, "done");
    expect(s.state).toBe("done");
  });

  it("transitions running to failed", () => {
    const s = makeSession({ state: "running" });
    transitionSession(s, "failed");
    expect(s.state).toBe("failed");
  });

  it("transitions paused to running", () => {
    const s = makeSession({ state: "paused" });
    transitionSession(s, "running");
    expect(s.state).toBe("running");
  });

  it("transitions failed to queued for retry", () => {
    const s = makeSession({ state: "failed" });
    transitionSession(s, "queued");
    expect(s.state).toBe("queued");
  });

  it("transitions running to cancelled", () => {
    const s = makeSession({ state: "running" });
    transitionSession(s, "cancelled");
    expect(s.state).toBe("cancelled");
  });

  it("throws on invalid transition done to running", () => {
    const s = makeSession({ state: "done" });
    expect(() => transitionSession(s, "running")).toThrow();
  });

  it("throws on invalid transition created to done", () => {
    const s = makeSession();
    expect(() => transitionSession(s, "done")).toThrow();
  });

  it("throws on self-transition running to running", () => {
    const s = makeSession({ state: "running" });
    expect(() => transitionSession(s, "running")).toThrow();
  });

  it("updates updatedAt on valid transition", () => {
    const s = makeSession();
    const before = s.updatedAt;
    transitionSession(s, "initializing");
    expect(typeof s.updatedAt).toBe("number");
    expect(s.updatedAt).toBeGreaterThanOrEqual(before);
  });
});

// ── TERMINAL_STATES / RESUMABLE_STATES ───────────────────────────────────────
describe("state sets", () => {
  it("terminal states contain done, cancelled, failed", () => {
    const terminal: SessionState[] = ["done", "cancelled", "failed"];
    for (const st of terminal) {
      expect(TERMINAL_STATES.has(st)).toBe(true);
    }
  });

  it("resumable states contain paused and failed", () => {
    expect(RESUMABLE_STATES.has("paused")).toBe(true);
    expect(RESUMABLE_STATES.has("failed")).toBe(true);
  });

  it("running is not resumable", () => {
    expect(RESUMABLE_STATES.has("running")).toBe(false);
  });
});

// ── getTransferredBytes ───────────────────────────────────────────────────────
describe("getTransferredBytes", () => {
  it("returns 0 when no chunks are done", () => {
    const s = makeSession({
      chunks: [makeChunkMeta(0, 0, 1024), makeChunkMeta(1, 1024, 1024)],
    });
    expect(getTransferredBytes(s)).toBe(0);
  });

  it("sums only done chunks", () => {
    const chunks = [
      { ...makeChunkMeta(0, 0, 1024), status: "done" as const },
      { ...makeChunkMeta(1, 1024, 2048), status: "uploading" as const },
      { ...makeChunkMeta(2, 3072, 512), status: "done" as const },
    ];
    expect(getTransferredBytes(makeSession({ chunks }))).toBe(1024 + 512);
  });
});

// ── getProgressPercent ────────────────────────────────────────────────────────
describe("getProgressPercent", () => {
  it("returns 100 for a zero-byte file", () => {
    const s = makeSession({ file: { name: "f", size: 0, mimeType: "" } });
    expect(getProgressPercent(s)).toBe(100);
  });

  it("returns 0 when no chunks are done", () => {
    const s = makeSession({
      file: { name: "f", size: 2000, mimeType: "" },
      chunks: [makeChunkMeta(0, 0, 1000), makeChunkMeta(1, 1000, 1000)],
    });
    expect(getProgressPercent(s)).toBe(0);
  });

  it("returns 50 when half the bytes are done", () => {
    const s = makeSession({
      file: { name: "f", size: 2000, mimeType: "" },
      chunks: [
        { ...makeChunkMeta(0, 0, 1000), status: "done" as const },
        makeChunkMeta(1, 1000, 1000),
      ],
    });
    expect(getProgressPercent(s)).toBe(50);
  });

  it("returns 100 when all chunks are done", () => {
    const s = makeSession({
      file: { name: "f", size: 2000, mimeType: "" },
      chunks: [
        { ...makeChunkMeta(0, 0, 1000), status: "done" as const },
        { ...makeChunkMeta(1, 1000, 1000), status: "done" as const },
      ],
    });
    expect(getProgressPercent(s)).toBe(100);
  });
});

// ── hasFatalChunks ────────────────────────────────────────────────────────────
describe("hasFatalChunks", () => {
  it("returns false when no chunks are fatal", () => {
    const s = makeSession({ chunks: [makeChunkMeta(0, 0, 1000)] });
    expect(hasFatalChunks(s)).toBe(false);
  });

  it("returns true when at least one chunk is fatal", () => {
    const s = makeSession({
      chunks: [
        makeChunkMeta(0, 0, 1000),
        { ...makeChunkMeta(1, 1000, 1000), status: "fatal" as const },
      ],
    });
    expect(hasFatalChunks(s)).toBe(true);
  });
});

// ── allChunksDone ─────────────────────────────────────────────────────────────
describe("allChunksDone", () => {
  it("returns false with a pending chunk", () => {
    const s = makeSession({
      chunks: [
        { ...makeChunkMeta(0, 0, 1000), status: "done" as const },
        makeChunkMeta(1, 1000, 1000),
      ],
    });
    expect(allChunksDone(s)).toBe(false);
  });

  it("returns true when every chunk is done", () => {
    const s = makeSession({
      chunks: [
        { ...makeChunkMeta(0, 0, 1000), status: "done" as const },
        { ...makeChunkMeta(1, 1000, 1000), status: "done" as const },
      ],
    });
    expect(allChunksDone(s)).toBe(true);
  });

  it("returns false for empty chunk list", () => {
    // Per implementation: chunks.length > 0 required
    expect(allChunksDone(makeSession({ chunks: [] }))).toBe(false);
  });
});
