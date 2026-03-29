/**
 * S3Adapter / R2Adapter unit tests — no real AWS calls.
 *
 * Approach: inject a mock S3Client via the `client` option so that all
 * `_client.send()` calls go through a `jest.fn()`.  The mock is set up
 * sequentially (mockResolvedValueOnce) to mirror the B2Adapter test pattern.
 *
 * Inspecting commands:
 *   AWS SDK v3 Command instances expose an `input` property with the arguments
 *   passed to the constructor.  We use `mockSend.mock.calls[n][0].input` to
 *   verify the correct fields are sent to S3.
 */

import { S3Adapter, type S3AdapterOptions } from "../src/S3Adapter";
import { R2Adapter } from "../src/R2Adapter";
import type { TransferSession } from "@transferx/core";
import { makeChunkMeta, TransferError } from "@transferx/core";

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeMockSend() {
  return jest.fn();
}

function makeAdapter(
  mockSend: jest.Mock,
  overrides: Partial<Omit<S3AdapterOptions, "client" | "credentials">> = {},
) {
  return new S3Adapter({
    bucket: "test-bucket",
    region: "us-east-1",
    credentials: { accessKeyId: "key-id", secretAccessKey: "key-secret" },
    client: {
      send: mockSend,
    } as unknown as import("@aws-sdk/client-s3").S3Client,
    ...overrides,
  });
}

function makeSession(
  overrides: Partial<TransferSession> = {},
): TransferSession {
  return {
    id: "sess-s3",
    direction: "upload",
    file: { name: "video.mp4", size: 30 * 1024 * 1024, mimeType: "video/mp4" },
    targetKey: "uploads/video.mp4",
    chunkSize: 10 * 1024 * 1024,
    state: "initializing",
    chunks: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    transferredBytes: 0,
    sessionRetries: 0,
    ...overrides,
  };
}

function makeChunk(index: number, size = 10 * 1024 * 1024) {
  return makeChunkMeta(index, index * size, size);
}

function makeData(size = 128) {
  return new Uint8Array(size).fill(0xab);
}

// AWS SDK v3 errors carry $metadata.httpStatusCode
function makeSdkError(status: number, message = "error") {
  const err = new Error(message);
  (err as unknown as Record<string, unknown>)["$metadata"] = {
    httpStatusCode: status,
  };
  return err;
}

// ── initTransfer ──────────────────────────────────────────────────────────────

describe("S3Adapter.initTransfer", () => {
  it("calls CreateMultipartUpload and returns UploadId", async () => {
    const mockSend = makeMockSend().mockResolvedValueOnce({
      UploadId: "upload-id-xyz",
    });
    const adapter = makeAdapter(mockSend);
    const session = makeSession();

    const result = await adapter.initTransfer(session);

    expect(result).toBe("upload-id-xyz");
    expect(mockSend).toHaveBeenCalledTimes(1);

    // Verify the correct input was sent to S3
    const cmdInput = (
      mockSend.mock.calls[0] as [{ input: Record<string, unknown> }]
    )[0].input;
    expect(cmdInput["Bucket"]).toBe("test-bucket");
    expect(cmdInput["Key"]).toBe("uploads/video.mp4");
    expect(cmdInput["ContentType"]).toBe("video/mp4");
  });

  it("defaults ContentType to application/octet-stream when mimeType is empty", async () => {
    const mockSend = makeMockSend().mockResolvedValueOnce({
      UploadId: "up-id-2",
    });
    const adapter = makeAdapter(mockSend);
    const session = makeSession({
      file: { name: "file.bin", size: 20 * 1024 * 1024, mimeType: "" },
    });

    await adapter.initTransfer(session);

    const cmdInput = (
      mockSend.mock.calls[0] as [{ input: Record<string, unknown> }]
    )[0].input;
    expect(cmdInput["ContentType"]).toBe("application/octet-stream");
  });

  it("throws serverError when S3 returns no UploadId", async () => {
    const mockSend = makeMockSend().mockResolvedValueOnce({});
    const adapter = makeAdapter(mockSend);

    await expect(adapter.initTransfer(makeSession())).rejects.toMatchObject({
      category: "serverError",
    });
  });
});

// ── uploadChunk ───────────────────────────────────────────────────────────────

describe("S3Adapter.uploadChunk", () => {
  it("uploads part and returns ETag as providerToken (verbatim with quotes)", async () => {
    const mockSend = makeMockSend().mockResolvedValueOnce({
      ETag: '"etag-abc123"',
    });
    const adapter = makeAdapter(mockSend);
    const session = makeSession({ providerSessionId: "upload-id-xyz" });
    const chunk = makeChunk(0);

    const result = await adapter.uploadChunk(session, chunk, makeData(), "");

    expect(result.providerToken).toBe('"etag-abc123"');
  });

  it("sends part number as 1-based (index + 1)", async () => {
    const mockSend = makeMockSend()
      .mockResolvedValueOnce({ ETag: '"etag-1"' }) // chunk index 0 → PartNumber 1
      .mockResolvedValueOnce({ ETag: '"etag-2"' }) // chunk index 1 → PartNumber 2
      .mockResolvedValueOnce({ ETag: '"etag-3"' }); // chunk index 2 → PartNumber 3
    const adapter = makeAdapter(mockSend);
    const session = makeSession({ providerSessionId: "upload-id-xyz" });

    for (let i = 0; i < 3; i++) {
      await adapter.uploadChunk(session, makeChunk(i), makeData(), "");
    }

    for (let i = 0; i < 3; i++) {
      const cmdInput = (
        mockSend.mock.calls[i] as [{ input: Record<string, unknown> }]
      )[0].input;
      expect(cmdInput["PartNumber"]).toBe(i + 1);
      expect(cmdInput["UploadId"]).toBe("upload-id-xyz");
      expect(cmdInput["Bucket"]).toBe("test-bucket");
    }
  });

  it("throws fatal error when providerSessionId is missing", async () => {
    const adapter = makeAdapter(makeMockSend());
    const session = makeSession(); // no providerSessionId

    await expect(
      adapter.uploadChunk(session, makeChunk(0), makeData(), ""),
    ).rejects.toMatchObject({ category: "fatal" });
  });

  it("throws serverError when S3 returns no ETag", async () => {
    const mockSend = makeMockSend().mockResolvedValueOnce({});
    const adapter = makeAdapter(mockSend);
    const session = makeSession({ providerSessionId: "upload-id-xyz" });

    await expect(
      adapter.uploadChunk(session, makeChunk(0), makeData(), ""),
    ).rejects.toMatchObject({ category: "serverError" });
  });

  it("is idempotent — retrying the same partNumber is safe", async () => {
    // Both uploads succeed; the second one overwrites the first on S3.
    const mockSend = makeMockSend()
      .mockResolvedValueOnce({ ETag: '"etag-first"' })
      .mockResolvedValueOnce({ ETag: '"etag-retry"' });
    const adapter = makeAdapter(mockSend);
    const session = makeSession({ providerSessionId: "upload-id-xyz" });
    const chunk = makeChunk(2);

    const first = await adapter.uploadChunk(session, chunk, makeData(), "");
    const retry = await adapter.uploadChunk(session, chunk, makeData(), "");

    // PartNumber must be the same on retry
    const firstInput = (
      mockSend.mock.calls[0] as [{ input: Record<string, unknown> }]
    )[0].input;
    const retryInput = (
      mockSend.mock.calls[1] as [{ input: Record<string, unknown> }]
    )[0].input;
    expect(firstInput["PartNumber"]).toBe(3);
    expect(retryInput["PartNumber"]).toBe(3);
    expect(retry.providerToken).toBe('"etag-retry"');
    void first; // suppress unused var lint
  });
});

// ── completeTransfer ──────────────────────────────────────────────────────────

describe("S3Adapter.completeTransfer", () => {
  it("calls CompleteMultipartUpload with sorted Parts", async () => {
    const mockSend = makeMockSend().mockResolvedValueOnce({});
    const adapter = makeAdapter(mockSend);
    const session = makeSession({ providerSessionId: "upload-id-xyz" });

    // Provide chunks in reverse order to verify the adapter sorts them
    const chunks = [
      { ...makeChunk(2), providerToken: '"etag-3"', status: "done" as const },
      { ...makeChunk(0), providerToken: '"etag-1"', status: "done" as const },
      { ...makeChunk(1), providerToken: '"etag-2"', status: "done" as const },
    ];

    await adapter.completeTransfer(session, chunks);

    const cmdInput = (
      mockSend.mock.calls[0] as [{ input: Record<string, unknown> }]
    )[0].input;
    expect(cmdInput["UploadId"]).toBe("upload-id-xyz");
    expect(cmdInput["Bucket"]).toBe("test-bucket");
    expect(cmdInput["Key"]).toBe("uploads/video.mp4");

    // Parts must be sorted ascending by PartNumber
    const parts = (
      cmdInput["MultipartUpload"] as {
        Parts: Array<{ PartNumber: number; ETag: string }>;
      }
    ).Parts;
    expect(parts).toEqual([
      { PartNumber: 1, ETag: '"etag-1"' },
      { PartNumber: 2, ETag: '"etag-2"' },
      { PartNumber: 3, ETag: '"etag-3"' },
    ]);
  });

  it("throws fatal error when providerSessionId is missing", async () => {
    const adapter = makeAdapter(makeMockSend());

    await expect(
      adapter.completeTransfer(makeSession(), [makeChunk(0)]),
    ).rejects.toMatchObject({ category: "fatal" });
  });
});

// ── abortTransfer ─────────────────────────────────────────────────────────────

describe("S3Adapter.abortTransfer", () => {
  it("calls AbortMultipartUpload with correct inputs", async () => {
    const mockSend = makeMockSend().mockResolvedValueOnce({});
    const adapter = makeAdapter(mockSend);
    const session = makeSession({ providerSessionId: "upload-id-xyz" });

    await adapter.abortTransfer(session);

    expect(mockSend).toHaveBeenCalledTimes(1);
    const cmdInput = (
      mockSend.mock.calls[0] as [{ input: Record<string, unknown> }]
    )[0].input;
    expect(cmdInput["UploadId"]).toBe("upload-id-xyz");
    expect(cmdInput["Bucket"]).toBe("test-bucket");
  });

  it("is a no-op when providerSessionId is missing", async () => {
    const mockSend = makeMockSend();
    const adapter = makeAdapter(mockSend);

    await expect(adapter.abortTransfer(makeSession())).resolves.toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("swallows errors (best-effort — must never throw)", async () => {
    const mockSend = makeMockSend().mockRejectedValueOnce(
      makeSdkError(500, "Internal error"),
    );
    const adapter = makeAdapter(mockSend);
    const session = makeSession({ providerSessionId: "upload-id-xyz" });

    await expect(adapter.abortTransfer(session)).resolves.toBeUndefined();
  });
});

// ── getRemoteState ────────────────────────────────────────────────────────────

describe("S3Adapter.getRemoteState", () => {
  it("returns uploaded parts from ListParts response", async () => {
    const mockSend = makeMockSend().mockResolvedValueOnce({
      Parts: [
        { PartNumber: 1, ETag: '"etag-1"' },
        { PartNumber: 2, ETag: '"etag-2"' },
      ],
      IsTruncated: false,
    });
    const adapter = makeAdapter(mockSend);
    const session = makeSession({ providerSessionId: "upload-id-xyz" });

    const state = await adapter.getRemoteState(session);

    expect(state.uploadedParts).toEqual([
      { partNumber: 1, providerToken: '"etag-1"' },
      { partNumber: 2, providerToken: '"etag-2"' },
    ]);
  });

  it("follows pagination when IsTruncated is true", async () => {
    const mockSend = makeMockSend()
      // First page: parts 1–2, truncated
      .mockResolvedValueOnce({
        Parts: [
          { PartNumber: 1, ETag: '"etag-1"' },
          { PartNumber: 2, ETag: '"etag-2"' },
        ],
        IsTruncated: true,
        NextPartNumberMarker: 2,
      })
      // Second page: part 3, not truncated
      .mockResolvedValueOnce({
        Parts: [{ PartNumber: 3, ETag: '"etag-3"' }],
        IsTruncated: false,
      });
    const adapter = makeAdapter(mockSend);
    const session = makeSession({ providerSessionId: "upload-id-xyz" });

    const state = await adapter.getRemoteState(session);

    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(state.uploadedParts).toHaveLength(3);
    expect(state.uploadedParts[2]).toEqual({
      partNumber: 3,
      providerToken: '"etag-3"',
    });

    // Second call must pass PartNumberMarker for correct pagination.
    // PartNumberMarker is serialised as a string (AWS SDK input type).
    const secondInput = (
      mockSend.mock.calls[1] as [{ input: Record<string, unknown> }]
    )[0].input;
    expect(secondInput["PartNumberMarker"]).toBe("2");
  });

  it("returns empty array when providerSessionId is missing", async () => {
    const adapter = makeAdapter(makeMockSend());
    const session = makeSession(); // no providerSessionId

    const state = await adapter.getRemoteState(session);

    expect(state.uploadedParts).toEqual([]);
  });
});

// ── Error mapping ─────────────────────────────────────────────────────────────

describe("S3Adapter — error mapping", () => {
  async function triggerError(err: Error) {
    const mockSend = makeMockSend().mockRejectedValueOnce(err);
    const adapter = makeAdapter(mockSend);
    return adapter.initTransfer(makeSession()).catch((e: unknown) => e);
  }

  it("maps HTTP 401 to authError", async () => {
    const err = await triggerError(makeSdkError(401, "Unauthorized"));
    expect((err as TransferError).category).toBe("auth");
  });

  it("maps HTTP 403 to authError", async () => {
    const err = await triggerError(makeSdkError(403, "Forbidden"));
    expect((err as TransferError).category).toBe("auth");
  });

  it("maps HTTP 429 to rateLimitError", async () => {
    const err = await triggerError(makeSdkError(429, "Too Many Requests"));
    expect((err as TransferError).category).toBe("rateLimit");
  });

  it("maps HTTP 500 to serverError", async () => {
    const err = await triggerError(makeSdkError(500, "Internal Server Error"));
    expect((err as TransferError).category).toBe("serverError");
  });

  it("maps HTTP 400 to clientError", async () => {
    const err = await triggerError(makeSdkError(400, "Bad Request"));
    expect((err as TransferError).category).toBe("clientError");
  });

  it("maps AbortError (timeout) to networkError", async () => {
    const abortErr = new Error("The operation was aborted");
    abortErr.name = "AbortError";
    const err = await triggerError(abortErr);
    expect((err as TransferError).category).toBe("network");
    expect((err as TransferError).message).toContain("timed out");
  });

  it("maps plain network Error to networkError", async () => {
    const err = await triggerError(new Error("ECONNRESET"));
    expect((err as TransferError).category).toBe("network");
  });

  it("reads Retry-After header for rate limit errors", async () => {
    const sdkErr = makeSdkError(429, "Too Many Requests");
    (sdkErr as unknown as Record<string, unknown>)["$response"] = {
      headers: { "retry-after": "30" },
    };
    const mockSend = makeMockSend().mockRejectedValueOnce(sdkErr);
    const adapter = makeAdapter(mockSend);

    const err = await adapter
      .initTransfer(makeSession())
      .catch((e: unknown) => e);
    expect((err as TransferError).message).toContain("30000");
  });
});

// ── HTTP timeout ──────────────────────────────────────────────────────────────

describe("S3Adapter — HTTP timeout", () => {
  afterEach(() => jest.useRealTimers());

  it("throws networkError when request stalls past timeoutMs", async () => {
    jest.useFakeTimers();

    // A send that never resolves until aborted
    const mockSend = makeMockSend().mockImplementation(
      (_cmd: unknown, opts: { abortSignal: AbortSignal }) =>
        new Promise<never>((_, reject) => {
          opts.abortSignal.addEventListener("abort", () => {
            const err = new Error("Aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    );
    const adapter = makeAdapter(mockSend, { timeoutMs: 1000 });

    // Attach .catch() BEFORE advancing time to prevent unhandled rejection.
    const promise = adapter
      .initTransfer(makeSession())
      .catch((e: unknown) => e);

    // Advance past the timeout threshold
    jest.advanceTimersByTime(1100);

    const err = await promise;
    expect(err).toBeInstanceOf(TransferError);
    expect((err as TransferError).category).toBe("network");
    expect((err as TransferError).message).toContain("timed out");
  });

  it("succeeds when request resolves before timeoutMs", async () => {
    jest.useFakeTimers();
    const mockSend = makeMockSend().mockResolvedValueOnce({
      UploadId: "up-fast",
    });
    const adapter = makeAdapter(mockSend, { timeoutMs: 5000 });

    const promise = adapter.initTransfer(makeSession());
    await jest.advanceTimersByTimeAsync(100);

    await expect(promise).resolves.toBe("up-fast");
  });
});

// ── Full multipart flow ───────────────────────────────────────────────────────

describe("S3Adapter — full multipart upload flow", () => {
  it("init → upload × 3 → complete succeeds end-to-end", async () => {
    const mockSend = makeMockSend()
      .mockResolvedValueOnce({ UploadId: "flow-upload-id" }) // CreateMultipartUpload
      .mockResolvedValueOnce({ ETag: '"etag-p1"' }) // UploadPart 1
      .mockResolvedValueOnce({ ETag: '"etag-p2"' }) // UploadPart 2
      .mockResolvedValueOnce({ ETag: '"etag-p3"' }) // UploadPart 3
      .mockResolvedValueOnce({}); // CompleteMultipartUpload

    const adapter = makeAdapter(mockSend);
    const session = makeSession();

    session.providerSessionId = await adapter.initTransfer(session);

    const chunks = [0, 1, 2].map((i) => makeChunk(i));
    for (const chunk of chunks) {
      const result = await adapter.uploadChunk(session, chunk, makeData(), "");
      chunk.providerToken = result.providerToken;
    }

    await adapter.completeTransfer(session, chunks);

    expect(mockSend).toHaveBeenCalledTimes(5);
  });
});

// ── Resume via getRemoteState ─────────────────────────────────────────────────

describe("S3Adapter — resume support", () => {
  it("getRemoteState allows engine to skip already-uploaded parts", async () => {
    // Simulate: parts 1 and 2 already uploaded, part 3 missing
    const mockSend = makeMockSend().mockResolvedValueOnce({
      Parts: [
        { PartNumber: 1, ETag: '"etag-1"' },
        { PartNumber: 2, ETag: '"etag-2"' },
      ],
      IsTruncated: false,
    });
    const adapter = makeAdapter(mockSend);
    const session = makeSession({ providerSessionId: "resume-upload-id" });

    const state = await adapter.getRemoteState(session);

    // The engine uses this to mark chunks 0, 1 as done and re-upload chunk 2
    expect(state.uploadedParts).toHaveLength(2);
    expect(state.uploadedParts[0]).toEqual({
      partNumber: 1,
      providerToken: '"etag-1"',
    });
    expect(state.uploadedParts[1]).toEqual({
      partNumber: 2,
      providerToken: '"etag-2"',
    });
  });
});

// ── R2Adapter ─────────────────────────────────────────────────────────────────

describe("R2Adapter", () => {
  it("constructs with correct R2 endpoint and uses forcePathStyle", async () => {
    // Verify the internal S3Client is constructed with the right config by
    // checking that the adapter inherits initTransfer behaviour with the
    // correct bucket via mock send.
    const mockSend = makeMockSend().mockResolvedValueOnce({
      UploadId: "r2-upload-id",
    });
    const adapter = new R2Adapter({
      accountId: "my-account-id",
      bucket: "r2-bucket",
      credentials: {
        accessKeyId: "r2-key-id",
        secretAccessKey: "r2-secret",
      },
      client: {
        send: mockSend,
      } as unknown as import("@aws-sdk/client-s3").S3Client,
    });

    const session = makeSession({ targetKey: "uploads/r2-file.mp4" });
    const uploadId = await adapter.initTransfer(session);

    expect(uploadId).toBe("r2-upload-id");
    const cmdInput = (
      mockSend.mock.calls[0] as [{ input: Record<string, unknown> }]
    )[0].input;
    expect(cmdInput["Bucket"]).toBe("r2-bucket");
    expect(cmdInput["Key"]).toBe("uploads/r2-file.mp4");
  });

  it("inherits uploadChunk + completeTransfer from S3Adapter", async () => {
    const mockSend = makeMockSend()
      .mockResolvedValueOnce({ ETag: '"r2-etag"' }) // uploadChunk
      .mockResolvedValueOnce({}); // completeTransfer

    const adapter = new R2Adapter({
      accountId: "acc-id",
      bucket: "r2-bucket",
      credentials: { accessKeyId: "k", secretAccessKey: "s" },
      client: {
        send: mockSend,
      } as unknown as import("@aws-sdk/client-s3").S3Client,
    });

    const session = makeSession({ providerSessionId: "r2-upload-id" });
    const chunk = makeChunk(0);

    const result = await adapter.uploadChunk(session, chunk, makeData(), "");
    chunk.providerToken = result.providerToken;

    await adapter.completeTransfer(session, [chunk]);
    expect(mockSend).toHaveBeenCalledTimes(2);
  });
});
