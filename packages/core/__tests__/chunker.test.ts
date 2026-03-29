import { computeChunks, validateChunks } from "../src/chunker/Chunker";
import type { ChunkMeta } from "../src/types/chunk";

const MB = 1024 * 1024;
const CHUNK = 10 * MB;

describe("computeChunks", () => {
  it("returns empty array for zero-byte file", () => {
    expect(computeChunks(0, CHUNK)).toEqual([]);
  });

  it("returns one chunk for 1-byte file", () => {
    const chunks = computeChunks(1, CHUNK);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ index: 0, offset: 0, size: 1 });
  });

  it("returns one chunk for file exactly equal to chunk size", () => {
    const chunks = computeChunks(CHUNK, CHUNK);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.size).toBe(CHUNK);
  });

  it("returns two chunks for file slightly larger than chunk size", () => {
    const chunks = computeChunks(CHUNK + 1, CHUNK);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.size).toBe(CHUNK);
    expect(chunks[1]!.size).toBe(1);
  });

  it("handles exact multiple (30 MiB / 10 MiB = 3 chunks)", () => {
    const chunks = computeChunks(30 * MB, CHUNK);
    expect(chunks).toHaveLength(3);
    for (const c of chunks) expect(c.size).toBe(CHUNK);
  });

  it("produces correct offsets", () => {
    const chunks = computeChunks(25 * MB, CHUNK);
    expect(chunks[0]!.offset).toBe(0);
    expect(chunks[1]!.offset).toBe(CHUNK);
    expect(chunks[2]!.offset).toBe(2 * CHUNK);
  });

  it("assigns sequential indices starting at 0", () => {
    const chunks = computeChunks(25 * MB, CHUNK);
    chunks.forEach((c: ChunkMeta, i: number) => expect(c.index).toBe(i));
  });

  it("last chunk has correct remainder size", () => {
    const remainder = 3 * MB;
    const chunks = computeChunks(2 * CHUNK + remainder, CHUNK);
    expect(chunks[2]!.size).toBe(remainder);
  });

  it("throws for non-positive chunk size", () => {
    expect(() => computeChunks(1024, 0)).toThrow(RangeError);
    expect(() => computeChunks(1024, -1)).toThrow(RangeError);
  });

  it("all chunks are initially pending", () => {
    const chunks = computeChunks(25 * MB, CHUNK);
    for (const c of chunks) expect(c.status).toBe("pending");
  });

  it("sum of chunk sizes equals file size", () => {
    const fileSize = 23_456_789;
    const chunks = computeChunks(fileSize, CHUNK);
    const total = chunks.reduce((acc: number, c: ChunkMeta) => acc + c.size, 0);
    expect(total).toBe(fileSize);
  });
});

describe("validateChunks", () => {
  function doneChunks(fileSize: number): ChunkMeta[] {
    return computeChunks(fileSize, CHUNK).map((c) => ({
      ...c,
      status: "done" as const,
    }));
  }

  it("does not throw for valid matching chunks", () => {
    const fileSize = 25 * MB;
    const chunks = doneChunks(fileSize);
    expect(() => validateChunks(chunks, fileSize, CHUNK)).not.toThrow();
  });

  it("throws when file size changed", () => {
    const chunks = doneChunks(25 * MB);
    expect(() => validateChunks(chunks, 26 * MB, CHUNK)).toThrow();
  });

  it("throws when chunk size changed", () => {
    const chunks = doneChunks(25 * MB);
    expect(() => validateChunks(chunks, 25 * MB, 5 * MB)).toThrow();
  });

  it("throws when chunk count is wrong", () => {
    const chunks = doneChunks(25 * MB).slice(0, 2); // only 2 of 3
    expect(() => validateChunks(chunks, 25 * MB, CHUNK)).toThrow();
  });

  it("does not throw for empty (0-byte) file with empty chunks", () => {
    expect(() => validateChunks([], 0, CHUNK)).not.toThrow();
  });
});
