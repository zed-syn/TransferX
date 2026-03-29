import { withRetry, computeBackoff } from "../src/retry/RetryEngine";
import type { RetryContext } from "../src/retry/RetryEngine";
import { makeChunkMeta } from "../src/types/chunk";
import {
  TransferError,
  networkError,
  clientError,
  rateLimitError,
  serverError,
} from "../src/types/errors";
import type { RetryPolicy } from "../src/types/config";

// Speed up tests — no real waiting
jest.useFakeTimers();

const FAST_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 1000,
  jitterMs: 0,
};

function makeCtx(overrides: Partial<RetryContext> = {}): RetryContext {
  return {
    chunk: makeChunkMeta(0, 0, 1024),
    policy: FAST_POLICY,
    ...overrides,
  };
}

// Helper: run operation + advance fake timers concurrently
async function runWithTimers<T>(promise: Promise<T>): Promise<T> {
  // Let microtasks settle, then advance timers in a loop
  let result!: T;
  let error: unknown;
  let settled = false;

  promise
    .then((v) => {
      result = v;
      settled = true;
    })
    .catch((e) => {
      error = e;
      settled = true;
    });

  while (!settled) {
    await Promise.resolve(); // flush microtasks
    jest.advanceTimersByTime(2000); // advance past any backoff
    await Promise.resolve();
  }

  if (error !== undefined) throw error;
  return result;
}

describe("withRetry — basic success", () => {
  it("returns value on first attempt", async () => {
    const op = jest.fn().mockResolvedValue("ok");
    const result = await runWithTimers(withRetry(op, makeCtx()));
    expect(result).toBe("ok");
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("succeeds on second attempt after retryable failure", async () => {
    const op = jest
      .fn()
      .mockRejectedValueOnce(networkError("timeout", undefined, 0))
      .mockResolvedValueOnce("ok");

    const result = await runWithTimers(withRetry(op, makeCtx()));
    expect(result).toBe("ok");
    expect(op).toHaveBeenCalledTimes(2);
  });
});

describe("withRetry — exhaustion", () => {
  it("throws after maxAttempts", async () => {
    const op = jest.fn().mockRejectedValue(networkError("fail", undefined, 0));

    await expect(
      runWithTimers(withRetry(op, makeCtx())),
    ).rejects.toBeInstanceOf(TransferError);
    expect(op).toHaveBeenCalledTimes(FAST_POLICY.maxAttempts);
  });
});

describe("withRetry — non-retryable failure", () => {
  it("does not retry clientError (4xx)", async () => {
    const err = clientError(400);
    const op = jest.fn().mockRejectedValue(err);

    await expect(runWithTimers(withRetry(op, makeCtx()))).rejects.toBe(err);
    expect(op).toHaveBeenCalledTimes(1); // no retries
  });
});

describe("withRetry — onRetryableFailure callback", () => {
  it("fires for each retryable failure", async () => {
    const failures: number[] = [];
    const ctx = makeCtx({
      onRetryableFailure: (
        _chunk: import("../src/types/chunk").ChunkMeta,
        _err: TransferError,
        attempt: number,
      ) => {
        failures.push(attempt);
      },
    });

    const op = jest
      .fn()
      .mockRejectedValueOnce(networkError("t", undefined, 0))
      .mockRejectedValueOnce(networkError("t", undefined, 0))
      .mockResolvedValueOnce("done");

    await runWithTimers(withRetry(op, ctx));
    expect(failures).toEqual([1, 2]);
  });
});

describe("withRetry — error normalisation", () => {
  it("wraps plain Error in TransferError", async () => {
    const op = jest.fn().mockRejectedValue(new Error("plain error"));

    await expect(
      runWithTimers(withRetry(op, makeCtx())),
    ).rejects.toBeInstanceOf(TransferError);
  });

  it("wraps string throws in TransferError", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const op = jest.fn().mockRejectedValue("string error" as any);

    await expect(
      runWithTimers(withRetry(op, makeCtx())),
    ).rejects.toBeInstanceOf(TransferError);
  });
});

describe("computeBackoff", () => {
  it("returns 60000 for rateLimit error by default", () => {
    const err = rateLimitError();
    const delay = computeBackoff(1, FAST_POLICY, err);
    expect(delay).toBe(60_000);
  });

  it("respects retry-after encoded in rateLimit error message", () => {
    const err = rateLimitError(5000);
    const delay = computeBackoff(1, FAST_POLICY, err);
    expect(delay).toBe(5000);
  });

  it("exponential cap does not exceed maxDelayMs", () => {
    const policy: RetryPolicy = {
      maxAttempts: 10,
      baseDelayMs: 100,
      maxDelayMs: 500,
      jitterMs: 0,
    };
    // At attempt 10, 100 * 2^10 = 102400 >> maxDelayMs=500
    // With jitter=0, delay should be in [0, 500]
    for (let i = 0; i < 20; i++) {
      const d = computeBackoff(10, policy, serverError(500));
      expect(d).toBeLessThanOrEqual(500);
    }
  });

  it("delay is non-negative", () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const d = computeBackoff(attempt, FAST_POLICY);
      expect(d).toBeGreaterThanOrEqual(0);
    }
  });
});
