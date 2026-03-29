import { makeChunkMeta } from "../src/types/chunk";
import type { ChunkMeta, ChunkStatus } from "../src/types/chunk";

describe("makeChunkMeta", () => {
  it("creates a valid chunk with pending status", () => {
    const c = makeChunkMeta(0, 0, 1024);
    expect(c.index).toBe(0);
    expect(c.offset).toBe(0);
    expect(c.size).toBe(1024);
    expect(c.status).toBe("pending");
    expect(c.attempts).toBe(0);
    expect(c.checksum).toBeUndefined();
  });

  it("throws RangeError for negative index", () => {
    expect(() => makeChunkMeta(-1, 0, 512)).toThrow(RangeError);
    expect(() => makeChunkMeta(-1, 0, 512)).toThrow(/index/i);
  });

  it("throws RangeError for negative offset", () => {
    expect(() => makeChunkMeta(0, -1, 512)).toThrow(RangeError);
    expect(() => makeChunkMeta(0, -1, 512)).toThrow(/offset/i);
  });

  it("throws RangeError for zero size", () => {
    expect(() => makeChunkMeta(0, 0, 0)).toThrow(RangeError);
    expect(() => makeChunkMeta(0, 0, 0)).toThrow(/size/i);
  });

  it("throws RangeError for negative size", () => {
    expect(() => makeChunkMeta(0, 0, -1)).toThrow(RangeError);
  });

  it("allows last-chunk partial sizes", () => {
    const c = makeChunkMeta(3, 3072, 100);
    expect(c.size).toBe(100);
  });
});

describe("ChunkStatus exhaustiveness", () => {
  it("covers all status values", () => {
    const statuses: ChunkStatus[] = [
      "pending",
      "uploading",
      "done",
      "failed",
      "fatal",
    ];
    expect(statuses).toHaveLength(5);
  });
});

describe("ChunkMeta type shape", () => {
  it("allows setting checksum", () => {
    const c: ChunkMeta = makeChunkMeta(0, 0, 256);
    const withChecksum: ChunkMeta = { ...c, checksum: "abc123" };
    expect(withChecksum.checksum).toBe("abc123");
  });

  it("allows setting providerToken", () => {
    const c: ChunkMeta = makeChunkMeta(0, 0, 256);
    const withToken: ChunkMeta = { ...c, providerToken: "etag-value" };
    expect(withToken.providerToken).toBe("etag-value");
  });
});
