import { ProgressEngine } from "../src/progress/ProgressEngine";
import type { TransferProgress } from "../src/types/events";

jest.useFakeTimers();

function makeEngine(
  totalBytes: number,
  onProgress: (p: TransferProgress) => void,
  intervalMs = 200,
  alpha = 0.2,
) {
  return new ProgressEngine({
    totalBytes,
    sessionId: "test-sess",
    intervalMs,
    alpha,
    onProgress,
  });
}

describe("ProgressEngine — percent calculation", () => {
  it("starts at 0%", () => {
    const engine = makeEngine(1000, () => {});
    expect(engine.snapshot().percent).toBe(0);
  });

  it("returns 100% for zero-byte file", () => {
    const engine = makeEngine(0, () => {});
    expect(engine.snapshot().percent).toBe(100);
  });

  it("returns 50% when half bytes confirmed", () => {
    const engine = makeEngine(1000, () => {});
    engine.confirmBytes(500);
    expect(engine.snapshot().percent).toBe(50);
  });

  it("returns 100% when all bytes confirmed", () => {
    const engine = makeEngine(1000, () => {});
    engine.confirmBytes(1000);
    expect(engine.snapshot().percent).toBe(100);
  });

  it("floors fractional percent", () => {
    const engine = makeEngine(3, () => {});
    engine.confirmBytes(1);
    expect(engine.snapshot().percent).toBe(33);
  });

  it("never exceeds 100% even if confirmBytes overshoots", () => {
    const engine = makeEngine(1000, () => {});
    engine.confirmBytes(1500);
    expect(engine.snapshot().percent).toBe(100);
  });
});

describe("ProgressEngine — ETA", () => {
  it("eta is undefined when speed is 0", () => {
    const engine = makeEngine(1000, () => {});
    expect(engine.snapshot().etaSeconds).toBeUndefined();
  });
});

describe("ProgressEngine — emission", () => {
  it("emits on interval after start()", () => {
    const calls: TransferProgress[] = [];
    const engine = makeEngine(1000, (p) => calls.push(p));
    engine.start();
    jest.advanceTimersByTime(600); // 3 ticks at 200ms
    engine.stop();
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });

  it("emits final snapshot on stop()", () => {
    const calls: TransferProgress[] = [];
    const engine = makeEngine(1000, (p) => calls.push(p));
    engine.confirmBytes(700);
    engine.stop();
    const last = calls[calls.length - 1]!;
    expect(last.transferredBytes).toBe(700);
  });

  it("does not emit after stop()", () => {
    const calls: TransferProgress[] = [];
    const engine = makeEngine(1000, (p) => calls.push(p));
    engine.start();
    engine.stop();
    const countAtStop = calls.length;
    jest.advanceTimersByTime(2000);
    expect(calls.length).toBe(countAtStop);
  });

  it("ignores confirmBytes after stop", () => {
    const engine = makeEngine(1000, () => {});
    engine.stop();
    engine.confirmBytes(500); // should be silently ignored
    expect(engine.snapshot().transferredBytes).toBe(0);
  });

  it("start() is idempotent — multiple calls do not double-emit", () => {
    const calls: TransferProgress[] = [];
    const engine = makeEngine(1000, (p) => calls.push(p));
    engine.start();
    engine.start(); // second call should be no-op
    jest.advanceTimersByTime(200);
    engine.stop();
    // Should be ~1 emission, not 2
    expect(calls.length).toBeLessThanOrEqual(2);
  });
});

describe("ProgressEngine — sessionId propagation", () => {
  it("embeds correct sessionId in all snapshots", () => {
    const calls: TransferProgress[] = [];
    const engine = new ProgressEngine({
      totalBytes: 500,
      sessionId: "my-session",
      intervalMs: 100,
      onProgress: (p: import("../src/types/events").TransferProgress) =>
        calls.push(p),
    });
    engine.start();
    jest.advanceTimersByTime(100);
    engine.stop();
    for (const p of calls) {
      expect(p.sessionId).toBe("my-session");
    }
  });
});
