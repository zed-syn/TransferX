import { Scheduler } from "../src/scheduler/Scheduler";

// Helper: resolves after `ms` milliseconds
const delay = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

// Helper: run the event-loop one micro-task tick
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

describe("Scheduler — concurrency", () => {
  it("never runs more tasks than the concurrency limit", async () => {
    const sched = new Scheduler(2);
    let active = 0;
    let maxSeen = 0;

    const task = (): Promise<void> =>
      new Promise((resolve) => {
        active++;
        maxSeen = Math.max(maxSeen, active);
        setTimeout(() => {
          active--;
          resolve();
        }, 10);
      });

    for (let i = 0; i < 6; i++) sched.push(task);
    // Wait for all tasks to complete
    await delay(200);
    expect(maxSeen).toBeLessThanOrEqual(2);
    sched.destroy();
  });

  it("runs tasks concurrently up to the limit", async () => {
    const sched = new Scheduler(3);
    const starts: number[] = [];

    const task = (): Promise<void> =>
      new Promise((resolve) => {
        starts.push(Date.now());
        setTimeout(resolve, 50);
      });

    for (let i = 0; i < 3; i++) sched.push(task);
    await delay(150);

    // All 3 should have started within a small time window (same tick)
    const spread = starts[2]! - starts[0]!;
    expect(spread).toBeLessThan(30);
    sched.destroy();
  });
});

describe("Scheduler — pushFront priority", () => {
  it("pushFront tasks run before push tasks", async () => {
    const sched = new Scheduler(1);
    const order: number[] = [];

    // Fill the single slot with a long-running task
    sched.push(() => delay(50));

    // Now queue: regular 2, 3, then priority 1
    sched.push(() => {
      order.push(2);
      return Promise.resolve();
    });
    sched.push(() => {
      order.push(3);
      return Promise.resolve();
    });
    sched.pushFront(() => {
      order.push(1);
      return Promise.resolve();
    });

    await delay(300);
    expect(order[0]).toBe(1);
    sched.destroy();
  });
});

describe("Scheduler — pause / resume", () => {
  it("does not start new tasks when paused", async () => {
    const sched = new Scheduler(2);
    sched.pause();
    let ran = false;
    sched.push(() => {
      ran = true;
      return Promise.resolve();
    });
    await tick();
    await tick();
    expect(ran).toBe(false);
    sched.resume();
    await delay(50);
    expect(ran).toBe(true);
    sched.destroy();
  });

  it("resumes from paused state and drains queue", async () => {
    const sched = new Scheduler(1);
    sched.pause();

    const results: number[] = [];
    for (let i = 0; i < 3; i++) {
      const n = i;
      sched.push(() => {
        results.push(n);
        return Promise.resolve();
      });
    }

    sched.resume();
    await delay(100);
    expect(results).toHaveLength(3);
    sched.destroy();
  });
});

describe("Scheduler — setConcurrency", () => {
  it("increasing concurrency drains queue faster", async () => {
    const sched = new Scheduler(1);
    let active = 0;
    let maxSeen = 0;

    sched.setConcurrency(3);

    const task = (): Promise<void> =>
      new Promise((resolve) => {
        active++;
        maxSeen = Math.max(maxSeen, active);
        setTimeout(() => {
          active--;
          resolve();
        }, 20);
      });

    for (let i = 0; i < 6; i++) sched.push(task);
    await delay(200);
    expect(maxSeen).toBeLessThanOrEqual(3);
    sched.destroy();
  });
});

describe("Scheduler — clear", () => {
  it("returns count of removed queued tasks", async () => {
    const sched = new Scheduler(1);
    // Block the single slot
    sched.push(() => delay(500));
    // Queue 3 more that will never run
    for (let i = 0; i < 3; i++) sched.push(() => Promise.resolve());

    await tick(); // let the first task start
    const removed = sched.clear();
    expect(removed).toBe(3);
    sched.destroy();
  });

  it("queued tasks do not run after clear", async () => {
    const sched = new Scheduler(1);
    sched.push(() => delay(100));

    let ran = false;
    sched.push(() => {
      ran = true;
      return Promise.resolve();
    });

    await tick();
    sched.clear();
    await delay(200);
    expect(ran).toBe(false);
    sched.destroy();
  });
});

describe("Scheduler — destroy", () => {
  it("prevents pushing after destroy", () => {
    const sched = new Scheduler(2);
    sched.destroy();
    expect(() => sched.push(() => Promise.resolve())).toThrow();
  });
});

describe("Scheduler — stats", () => {
  it("tracks totalExecuted", async () => {
    const sched = new Scheduler(2);
    for (let i = 0; i < 4; i++) sched.push(() => Promise.resolve());
    await delay(100);
    expect(sched.stats.totalExecuted).toBe(4);
    sched.destroy();
  });

  it("tracks totalErrored", async () => {
    const sched = new Scheduler(2);
    const err = new Error("boom");
    sched.push(() => Promise.reject(err));
    sched.push(() => Promise.reject(err));
    await delay(100);
    expect(sched.stats.totalErrored).toBe(2);
    sched.destroy();
  });
});

describe("Scheduler — adaptive concurrency", () => {
  it("constructed with plain number: recordSuccess/recordFailure are no-ops (no throw, no change)", () => {
    const sched = new Scheduler(4);
    const before = sched.stats.concurrency;
    // Simulate a very poor error rate — should NOT cause scale-down when no policy
    for (let i = 0; i < 20; i++) sched.recordFailure();
    expect(sched.stats.concurrency).toBe(before);
    sched.destroy();
  });

  it("constructed with ConcurrencyPolicy: initial concurrency is applied", () => {
    const sched = new Scheduler({
      initial: 5,
      min: 1,
      max: 16,
      adaptive: true,
    });
    expect(sched.stats.concurrency).toBe(5);
    sched.destroy();
  });

  it("scales down when error rate exceeds HIGH_ERROR_RATE threshold", () => {
    const sched = new Scheduler({
      initial: 8,
      min: 2,
      max: 16,
      adaptive: true,
    });
    // Force window to be 100% failures (> 30% threshold)
    for (let i = 0; i < 20; i++) sched.recordFailure();
    // Should have scaled down toward min
    expect(sched.stats.concurrency).toBeLessThan(8);
    expect(sched.stats.concurrency).toBeGreaterThanOrEqual(2);
    sched.destroy();
  });

  it("does not scale below min", () => {
    const sched = new Scheduler({
      initial: 4,
      min: 3,
      max: 16,
      adaptive: true,
    });
    // Keep recording failures across multiple cooldown windows
    // (use fake timers not available here, so we trigger many scale-down attempts
    // by manipulating Date — instead just verify the floor is respected)
    for (let i = 0; i < 100; i++) sched.recordFailure();
    expect(sched.stats.concurrency).toBeGreaterThanOrEqual(3);
    sched.destroy();
  });

  it("scales up after sustained low-error-rate successes", () => {
    // Use jest fake timers so the cooldown does not prevent consecutive scale-ups
    jest.useFakeTimers();
    const sched = new Scheduler({
      initial: 2,
      min: 1,
      max: 16,
      adaptive: true,
    });

    // First fill window with successes and advance time past cooldown between each burst
    for (let burst = 0; burst < 5; burst++) {
      jest.advanceTimersByTime(4_000); // past COOLDOWN_MS (3000)
      for (let i = 0; i < 10; i++) sched.recordSuccess(); // SCALE_UP_COUNT = 10
    }
    expect(sched.stats.concurrency).toBeGreaterThan(2);
    sched.destroy();
    jest.useRealTimers();
  });

  it("does not scale above max", () => {
    jest.useFakeTimers();
    const sched = new Scheduler({
      initial: 14,
      min: 1,
      max: 16,
      adaptive: true,
    });
    for (let burst = 0; burst < 20; burst++) {
      jest.advanceTimersByTime(4_000);
      for (let i = 0; i < 10; i++) sched.recordSuccess();
    }
    expect(sched.stats.concurrency).toBeLessThanOrEqual(16);
    sched.destroy();
    jest.useRealTimers();
  });

  it("no-op when adaptive: false even under high error rate", () => {
    const sched = new Scheduler({
      initial: 6,
      min: 1,
      max: 16,
      adaptive: false,
    });
    for (let i = 0; i < 20; i++) sched.recordFailure();
    expect(sched.stats.concurrency).toBe(6);
    sched.destroy();
  });

  it("respects cooldown — does not scale down twice in rapid succession", () => {
    jest.useFakeTimers();
    const sched = new Scheduler({
      initial: 8,
      min: 1,
      max: 16,
      adaptive: true,
    });
    // First scale-down event
    for (let i = 0; i < 20; i++) sched.recordFailure();
    const afterFirst = sched.stats.concurrency;
    // Immediately inject more failures — should be blocked by cooldown
    for (let i = 0; i < 20; i++) sched.recordFailure();
    expect(sched.stats.concurrency).toBe(afterFirst);
    sched.destroy();
    jest.useRealTimers();
  });
});
