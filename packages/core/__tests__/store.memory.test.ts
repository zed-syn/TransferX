import { MemorySessionStore } from "../src/store/MemorySessionStore";
import { makeChunkMeta } from "../src/types/chunk";
import type { TransferSession } from "../src/types/session";

function makeSession(id = "sess-1"): TransferSession {
  return {
    id,
    direction: "upload",
    file: {
      name: "file.bin",
      size: 1024,
      mimeType: "application/octet-stream",
    },
    chunkSize: 512,
    state: "running",
    chunks: [makeChunkMeta(0, 0, 512), makeChunkMeta(1, 512, 512)],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    transferredBytes: 0,
    targetKey: "uploads/file.bin",
    sessionRetries: 0,
  };
}

describe("MemorySessionStore", () => {
  let store: MemorySessionStore;

  beforeEach(() => {
    store = new MemorySessionStore();
  });

  it("load returns undefined for unknown session", async () => {
    await expect(store.load("ghost")).resolves.toBeUndefined();
  });

  it("save then load round-trips correctly", async () => {
    const s = makeSession();
    await store.save(s);
    const loaded = await store.load(s.id);
    expect(loaded).toEqual(s);
  });

  it("save overwrites existing session", async () => {
    const s = makeSession();
    await store.save(s);
    const updated: TransferSession = { ...s, state: "done" };
    await store.save(updated);
    const loaded = await store.load(s.id);
    expect(loaded?.state).toBe("done");
  });

  it("delete removes session", async () => {
    const s = makeSession();
    await store.save(s);
    await store.delete(s.id);
    await expect(store.load(s.id)).resolves.toBeUndefined();
  });

  it("delete is idempotent", async () => {
    await expect(store.delete("nonexistent")).resolves.not.toThrow();
  });

  it("listAll returns all saved sessions", async () => {
    await store.save(makeSession("a"));
    await store.save(makeSession("b"));
    await store.save(makeSession("c"));
    const all = await store.listAll();
    expect(all).toHaveLength(3);
    const ids = all.map((s: TransferSession) => s.id).sort();
    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("listAll returns empty array when store is empty", async () => {
    await expect(store.listAll()).resolves.toEqual([]);
  });

  it("save returns deep copy so external mutation does not corrupt store", async () => {
    const s = makeSession();
    await store.save(s);
    s.state = "cancelled";
    s.chunks[0]!.status = "fatal";
    const loaded = await store.load(s.id);
    expect(loaded?.state).toBe("running");
    expect(loaded?.chunks[0]?.status).toBe("pending");
  });

  it("load returns deep copy so mutation does not corrupt store", async () => {
    const s = makeSession();
    await store.save(s);
    const loaded1 = await store.load(s.id);
    loaded1!.state = "cancelled";
    const loaded2 = await store.load(s.id);
    expect(loaded2!.state).toBe("running");
  });

  it("size property reflects current count", async () => {
    expect(store.size).toBe(0);
    await store.save(makeSession("a"));
    expect(store.size).toBe(1);
    await store.delete("a");
    expect(store.size).toBe(0);
  });

  it("clear empties the store", async () => {
    await store.save(makeSession("a"));
    await store.save(makeSession("b"));
    store.clear();
    expect(store.size).toBe(0);
    await expect(store.listAll()).resolves.toEqual([]);
  });
});
