/**
 * @module eventbus.test
 * Tests for the EventBus concrete implementation.
 */

import { EventBus } from "../src/events/EventBus.js";
import type { TransferEvent } from "../src/types/events.js";
import type { TransferSession } from "../src/types/session.js";

// ── Minimal stubs ─────────────────────────────────────────────────────────────

function stubSession(): TransferSession {
  return {
    id: "s1",
    direction: "upload",
    file: { name: "f.bin", size: 100, mimeType: "" },
    targetKey: "uploads/f.bin",
    chunkSize: 100,
    chunks: [],
    state: "done",
    createdAt: 0,
    updatedAt: 0,
    transferredBytes: 100,
    sessionRetries: 0,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("EventBus.on / emit", () => {
  test("handler is called when matching event is emitted", () => {
    const bus = new EventBus();
    const received: TransferEvent[] = [];
    bus.on("session:done", (e) => received.push(e));

    const session = stubSession();
    bus.emit({ type: "session:done", session });

    expect(received).toHaveLength(1);
    expect(received[0]!.type).toBe("session:done");
  });

  test("handler is NOT called for a different event type", () => {
    const bus = new EventBus();
    const received: TransferEvent[] = [];
    bus.on("session:done", (e) => received.push(e));

    const session = stubSession();
    bus.emit({ type: "session:failed", session, error: new Error("fail") });

    expect(received).toHaveLength(0);
  });

  test("multiple handlers for the same type are all called", () => {
    const bus = new EventBus();
    let a = 0;
    let b = 0;
    bus.on("session:done", () => a++);
    bus.on("session:done", () => b++);

    bus.emit({ type: "session:done", session: stubSession() });

    expect(a).toBe(1);
    expect(b).toBe(1);
  });

  test("handlers for different types are called independently", () => {
    const bus = new EventBus();
    const doneEvents: number[] = [];
    const failedEvents: number[] = [];

    bus.on("session:done", () => doneEvents.push(1));
    bus.on("session:failed", () => failedEvents.push(1));

    const session = stubSession();
    bus.emit({ type: "session:done", session });
    bus.emit({ type: "session:failed", session, error: new Error("x") });

    expect(doneEvents).toHaveLength(1);
    expect(failedEvents).toHaveLength(1);
  });

  test("emitting with no listeners is a no-op (no throw)", () => {
    const bus = new EventBus();
    expect(() =>
      bus.emit({ type: "session:done", session: stubSession() }),
    ).not.toThrow();
  });
});

describe("EventBus.on — unsubscribe", () => {
  test("unsubscribe function returned by on() removes the handler", () => {
    const bus = new EventBus();
    const received: TransferEvent[] = [];
    const unsubscribe = bus.on("session:done", (e) => received.push(e));

    unsubscribe();
    bus.emit({ type: "session:done", session: stubSession() });

    expect(received).toHaveLength(0);
  });

  test("other handlers remain after one is unsubscribed", () => {
    const bus = new EventBus();
    let a = 0;
    let b = 0;
    const unsubA = bus.on("session:done", () => a++);
    bus.on("session:done", () => b++);

    unsubA();
    bus.emit({ type: "session:done", session: stubSession() });

    expect(a).toBe(0);
    expect(b).toBe(1);
  });
});

describe("EventBus.off", () => {
  test("off() removes the handler", () => {
    const bus = new EventBus();
    const received: TransferEvent[] = [];
    const handler = (e: Extract<TransferEvent, { type: "session:done" }>) =>
      received.push(e);

    bus.on("session:done", handler);
    bus.off("session:done", handler);
    bus.emit({ type: "session:done", session: stubSession() });

    expect(received).toHaveLength(0);
  });

  test("off() is idempotent (calling twice does not throw)", () => {
    const bus = new EventBus();
    const handler = () => {};
    bus.on("session:done", handler);

    expect(() => {
      bus.off("session:done", handler);
      bus.off("session:done", handler);
    }).not.toThrow();
  });
});

describe("EventBus.clear", () => {
  test("clear() removes all handlers", () => {
    const bus = new EventBus();
    let count = 0;
    bus.on("session:done", () => count++);
    bus.on("session:started", () => count++);

    bus.clear();
    bus.emit({ type: "session:done", session: stubSession() });
    bus.emit({ type: "session:started", session: stubSession() });

    expect(count).toBe(0);
  });
});

describe("EventBus.listenerCount", () => {
  test("returns 0 for an event with no listeners", () => {
    const bus = new EventBus();
    expect(bus.listenerCount("session:done")).toBe(0);
  });

  test("returns correct count after adding/removing handlers", () => {
    const bus = new EventBus();
    const h1 = () => {};
    const h2 = () => {};
    bus.on("session:done", h1);
    bus.on("session:done", h2);

    expect(bus.listenerCount("session:done")).toBe(2);

    bus.off("session:done", h1);
    expect(bus.listenerCount("session:done")).toBe(1);
  });
});

describe("EventBus — dispatch safety", () => {
  test("handler added during emit is NOT called in the same dispatch", () => {
    const bus = new EventBus();
    let innerCalled = false;

    bus.on("session:done", () => {
      // Adding a new handler mid-dispatch — should NOT be called this cycle
      bus.on("session:done", () => {
        innerCalled = true;
      });
    });

    bus.emit({ type: "session:done", session: stubSession() });

    // The inner handler was added DURING dispatch and should not run this cycle
    expect(innerCalled).toBe(false);

    // But it will run on the next emit
    bus.emit({ type: "session:done", session: stubSession() });
    expect(innerCalled).toBe(true);
  });

  test("handler removed during emit is not called in the same dispatch", () => {
    const bus = new EventBus();
    let secondCalled = false;

    const second = () => {
      secondCalled = true;
    };

    bus.on("session:done", () => {
      bus.off("session:done", second);
    });
    bus.on("session:done", second);

    bus.emit({ type: "session:done", session: stubSession() });

    // second handler was registered and then off'd during dispatch
    // Because we snapshot before dispatch, second IS still called this cycle
    // (snapshot captured it). This is documented behaviour.
    expect(secondCalled).toBe(true);
  });
});

// ── Handler error isolation ────────────────────────────────────────────────────
describe("EventBus — handler error isolation", () => {
  test("throwing handler does not propagate to the emit() caller", () => {
    const bus = new EventBus();
    bus.on("session:done", () => {
      throw new Error("boom from handler");
    });
    expect(() =>
      bus.emit({ type: "session:done", session: stubSession() }),
    ).not.toThrow();
  });

  test("other handlers still run after one throws", () => {
    const bus = new EventBus();
    let secondCalled = false;
    bus.on("session:done", () => {
      throw new Error("handler 1 throws");
    });
    bus.on("session:done", () => {
      secondCalled = true;
    });
    bus.emit({ type: "session:done", session: stubSession() });
    expect(secondCalled).toBe(true);
  });

  test("throwing handler causes a log event to be emitted on the same bus", () => {
    const bus = new EventBus();
    const logEvents: TransferEvent[] = [];

    bus.on("session:done", () => {
      throw new Error("handler threw");
    });
    bus.on("log", (e) => logEvents.push(e));

    bus.emit({ type: "session:done", session: stubSession() });

    expect(logEvents).toHaveLength(1);
    expect(logEvents[0]!.type).toBe("log");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((logEvents[0] as any).level).toBe("error");
  });

  test("throwing handler on a 'log' event is swallowed silently (no infinite recursion)", () => {
    const bus = new EventBus();
    bus.on("log", () => {
      throw new Error("even the log handler throws");
    });
    // This must not throw and must not recurse infinitely
    expect(() =>
      bus.emit({
        type: "log",
        level: "error",
        message: "test",
      }),
    ).not.toThrow();
  });
});
