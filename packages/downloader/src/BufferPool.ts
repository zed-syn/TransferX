/**
 * @module BufferPool
 *
 * Reusable buffer pool for write-coalescing in FileWriter.
 *
 * Problem solved:
 *   ReadableStream frames from fetch() arrive as small Uint8Array slices
 *   (typically 16–64 KiB each). Without pooling, each slice triggers:
 *     1. Buffer.from() allocation  → GC pressure
 *     2. fs.write() syscall        → kernel context-switch overhead
 *   At 1 Gbps throughput this produces ~50 000 allocations + syscalls per second,
 *   creating measurable GC pauses that reduce effective throughput by 10–30%.
 *
 * Solution:
 *   - Pre-allocate a set of fixed-size Buffers (default: 256 KiB each).
 *   - FileWriter.writeStream() acquires one buffer, copies incoming frames
 *     into it, and flushes to disk only when the buffer is full or the stream
 *     ends. This coalesces many small writes into fewer, larger syscalls.
 *   - After each flush the buffer is returned to the pool for reuse.
 *
 * Memory footprint:
 *   maxPooled × bufferSize = 64 × 256 KiB = 16 MiB default maximum.
 *   In practice the pool stays at concurrency × 256 KiB (one buffer per
 *   active connection) since each writeStream() holds exactly one buffer
 *   from acquire() to release().
 *
 * Thread safety:
 *   Node.js is single-threaded at the JS level. acquire() / release() are
 *   synchronous array operations and require no locking.
 */

const DEFAULT_BUF_SIZE = 256 * 1024; // 256 KiB — coalesces ~4–16 stream frames
const DEFAULT_MAX_POOLED = 64; // bounds pool to ~16 MiB

export class BufferPool {
  /** Size of every buffer in this pool (bytes). Fixed at construction time. */
  readonly bufferSize: number;

  private readonly _maxPooled: number;
  private readonly _free: Buffer[];

  constructor(
    bufferSize: number = DEFAULT_BUF_SIZE,
    maxPooled: number = DEFAULT_MAX_POOLED,
  ) {
    this.bufferSize = bufferSize;
    this._maxPooled = Math.max(1, maxPooled);
    this._free = [];
  }

  /**
   * Acquire a buffer from the pool.
   * If the pool is empty a new Buffer is allocated.
   * The returned buffer may contain stale data — callers must
   * populate it before use (it is always returned by the write path
   * after filling, so content correctness is guaranteed by the caller).
   */
  acquire(): Buffer {
    return this._free.pop() ?? Buffer.allocUnsafe(this.bufferSize);
  }

  /**
   * Return a buffer to the pool for later reuse.
   * Only buffers whose byteLength equals this pool's bufferSize are
   * accepted; buffers of differing sizes are silently discarded.
   */
  release(buf: Buffer): void {
    if (
      this._free.length < this._maxPooled &&
      buf.byteLength === this.bufferSize
    ) {
      this._free.push(buf);
    }
  }

  /** Number of buffers currently available in the pool. */
  get freeCount(): number {
    return this._free.length;
  }
}
