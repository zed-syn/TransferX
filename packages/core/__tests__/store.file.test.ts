import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { FileSessionStore } from "../src/store/FileSessionStore";
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

describe("FileSessionStore", () => {
  let storeDir: string;
  let store: FileSessionStore;

  beforeEach(async () => {
    storeDir = await fs.mkdtemp(path.join(os.tmpdir(), "transferx-test-"));
    store = new FileSessionStore(storeDir);
  });

  afterEach(async () => {
    await fs.rm(storeDir, { recursive: true, force: true });
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

  it("save creates a .json file on disk", async () => {
    const s = makeSession("disk-check");
    await store.save(s);
    const file = path.join(storeDir, "disk-check.json");
    await expect(fs.access(file)).resolves.not.toThrow();
  });

  it("no .tmp file left after save", async () => {
    await store.save(makeSession());
    const files = await fs.readdir(storeDir);
    const tmps = files.filter((f: string) => f.endsWith(".tmp"));
    expect(tmps).toHaveLength(0);
  });

  it("save overwrites existing session", async () => {
    const s = makeSession();
    await store.save(s);
    await store.save({ ...s, state: "done" });
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
    const all = await store.listAll();
    expect(all).toHaveLength(2);
    const ids = all.map((s: TransferSession) => s.id).sort();
    expect(ids).toEqual(["a", "b"]);
  });

  it("listAll skips corrupted files gracefully", async () => {
    await store.save(makeSession("good"));
    await fs.writeFile(
      path.join(storeDir, "bad.json"),
      "{ not valid json",
      "utf8",
    );
    const all = await store.listAll();
    expect(all.map((s: TransferSession) => s.id)).toContain("good");
  });

  it("creates storeDir automatically if it does not exist", async () => {
    const subDir = path.join(storeDir, "nested", "store");
    const freshStore = new FileSessionStore(subDir);
    await freshStore.save(makeSession());
    await expect(fs.access(subDir)).resolves.not.toThrow();
  });

  it("sanitises special characters in sessionId for filename", async () => {
    const s = makeSession("sess/../../etc/passwd");
    await store.save(s);
    const files = await fs.readdir(storeDir);
    for (const f of files) {
      const combined = path.join(storeDir, f);
      expect(combined.startsWith(storeDir)).toBe(true);
    }
  });
});
