/**
 * @module chunker/NodeChunkReader
 *
 * Node.js implementation of IChunkReader backed by fs.promises.
 * Opens a file handle once and reads slices on demand.
 */

import * as fs from "fs";
import type { IChunkReader } from "./Chunker.js";

export class NodeChunkReader implements IChunkReader {
  private fh: fs.promises.FileHandle | null = null;

  constructor(private readonly filePath: string) {}

  private async handle(): Promise<fs.promises.FileHandle> {
    if (!this.fh) {
      this.fh = await fs.promises.open(this.filePath, "r");
    }
    return this.fh;
  }

  async read(offset: number, size: number): Promise<Uint8Array> {
    const fh = await this.handle();
    const buf = Buffer.allocUnsafe(size);
    const { bytesRead } = await fh.read(buf, 0, size, offset);
    if (bytesRead !== size) {
      throw new Error(
        `NodeChunkReader: expected to read ${size} bytes at offset ${offset}, got ${bytesRead}`,
      );
    }
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  async close(): Promise<void> {
    if (this.fh) {
      await this.fh.close();
      this.fh = null;
    }
  }
}
