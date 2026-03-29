/**
 * B2Adapter unit tests — no network calls.
 * All HTTP is intercepted via a mock `fetch` injected in the constructor.
 */
import { B2Adapter } from "../src/B2Adapter";
import type { TransferSession } from "@transferx/core";
import { makeChunkMeta, TransferError } from "@transferx/core";

// ── Mock helpers ───────────────────────────────────────────────────────────

function mockFetch(
  responses: Array<{
    status: number;
    json?: unknown;
    text?: string;
    headers?: Record<string, string>;
  }>,
) {
  let index = 0;
  return jest.fn().mockImplementation(() => {
    const r = responses[index++];
    if (!r) throw new Error("Unexpected extra fetch call");
    return Promise.resolve({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: new Headers(r.headers ?? {}),
      json: () => Promise.resolve(r.json ?? {}),
      text: () => Promise.resolve(r.text ?? ""),
    } as Response);
  });
}

const AUTH_RESPONSE = {
  accountId: "acc123",
  authorizationToken: "token-abc",
  apiUrl: "https://apiNNN.backblazeb2.com",
  downloadUrl: "https://f000.backblazeb2.com",
};

const START_LARGE_FILE_RESPONSE = { fileId: "file-id-xyz" };
const GET_UPLOAD_PART_URL_RESPONSE = {
  uploadUrl: "https://upload.example.com/upload",
  authorizationToken: "upload-token",
};
const UPLOAD_PART_RESPONSE = { contentSha1: "sha1abc" };

function makeAdapter(
  responses: Array<{ status: number; json?: unknown; text?: string }>,
) {
  return new B2Adapter({
    applicationKeyId: "key-id",
    applicationKey: "key-secret",
    bucketId: "bucket-id",
    fetch: mockFetch(responses),
  });
}

function makeSession(
  overrides: Partial<TransferSession> = {},
): TransferSession {
  return {
    id: "sess-1",
    direction: "upload",
    file: { name: "video.mp4", size: 20 * 1024 * 1024, mimeType: "video/mp4" },
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

// ── initTransfer ──────────────────────────────────────────────────────────────
describe("B2Adapter.initTransfer", () => {
  it("authorises then starts large file, returns fileId", async () => {
    const adapter = makeAdapter([
      { status: 200, json: AUTH_RESPONSE },
      { status: 200, json: START_LARGE_FILE_RESPONSE },
    ]);
    const fileId = await adapter.initTransfer(makeSession());
    expect(fileId).toBe("file-id-xyz");
  });

  it("caches auth token across calls", async () => {
    const fetchMock = mockFetch([
      { status: 200, json: AUTH_RESPONSE },
      { status: 200, json: START_LARGE_FILE_RESPONSE },
      { status: 200, json: START_LARGE_FILE_RESPONSE }, // second initTransfer, no second auth
    ]);
    const adapter = new B2Adapter({
      applicationKeyId: "k",
      applicationKey: "s",
      bucketId: "b",
      fetch: fetchMock,
    });
    await adapter.initTransfer(makeSession());
    await adapter.initTransfer(makeSession());
    // Auth call (1) + startLargeFile (2) + startLargeFile (3) = 3 total
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("throws authError on 401 during authorisation", async () => {
    const adapter = makeAdapter([{ status: 401, text: "Unauthorized" }]);
    await expect(adapter.initTransfer(makeSession())).rejects.toBeInstanceOf(
      TransferError,
    );
  });
});

// ── uploadChunk ────────────────────────────────────────────────────────────────
describe("B2Adapter.uploadChunk", () => {
  it("gets upload-part URL then uploads data, returns providerToken", async () => {
    const adapter = makeAdapter([
      { status: 200, json: AUTH_RESPONSE },
      { status: 200, json: GET_UPLOAD_PART_URL_RESPONSE },
      { status: 200, json: UPLOAD_PART_RESPONSE },
    ]);
    const session = makeSession({ providerSessionId: "file-id-xyz" });
    const chunk = makeChunkMeta(0, 0, 1024);
    const result = await adapter.uploadChunk(
      session,
      chunk,
      new Uint8Array(1024),
      "sha256fake",
    );
    expect(result.providerToken).toBe("sha1abc");
  });

  it("throws if providerSessionId is missing", async () => {
    const adapter = makeAdapter([{ status: 200, json: AUTH_RESPONSE }]);
    const session = makeSession(); // no providerSessionId
    await expect(
      adapter.uploadChunk(
        session,
        makeChunkMeta(0, 0, 512),
        new Uint8Array(512),
        "sha",
      ),
    ).rejects.toBeInstanceOf(TransferError);
  });

  it("transparently re-authorises and succeeds when first upload attempt returns 401", async () => {
    // Sequence: auth → getUploadPartUrl → upload(401) → re-auth → getUploadPartUrl → upload(200)
    const adapter = makeAdapter([
      { status: 200, json: AUTH_RESPONSE }, // initial auth
      { status: 200, json: GET_UPLOAD_PART_URL_RESPONSE }, // first getUploadPartUrl
      { status: 401, text: "Unauthorized" }, // first upload attempt: token expired
      { status: 200, json: AUTH_RESPONSE }, // re-auth succeeds
      { status: 200, json: GET_UPLOAD_PART_URL_RESPONSE }, // second getUploadPartUrl
      { status: 200, json: UPLOAD_PART_RESPONSE }, // second upload attempt: success
    ]);
    const session = makeSession({ providerSessionId: "fid" });
    const result = await adapter.uploadChunk(
      session,
      makeChunkMeta(0, 0, 512),
      new Uint8Array(512),
      "sha",
    );
    expect(result.providerToken).toBe("sha1abc");
  });

  it("throws authError if second upload attempt after transparent re-auth also returns 401", async () => {
    // Sequence: auth → getUploadPartUrl → upload(401) → re-auth → getUploadPartUrl → upload(401 again)
    const adapter = makeAdapter([
      { status: 200, json: AUTH_RESPONSE }, // initial auth
      { status: 200, json: GET_UPLOAD_PART_URL_RESPONSE }, // first getUploadPartUrl
      { status: 401, text: "Unauthorised" }, // first upload: token expired
      { status: 200, json: AUTH_RESPONSE }, // re-auth succeeds
      { status: 200, json: GET_UPLOAD_PART_URL_RESPONSE }, // second getUploadPartUrl
      { status: 401, text: "Unauthorised" }, // second upload: still 401
    ]);
    const session = makeSession({ providerSessionId: "fid" });
    const err = await adapter
      .uploadChunk(
        session,
        makeChunkMeta(0, 0, 512),
        new Uint8Array(512),
        "sha",
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransferError);
    expect((err as TransferError).category).toBe("auth");
  });

  it("throws rateLimit error on HTTP 429", async () => {
    const adapter = makeAdapter([
      { status: 200, json: AUTH_RESPONSE },
      { status: 200, json: GET_UPLOAD_PART_URL_RESPONSE },
      { status: 429, text: "" },
    ]);
    const session = makeSession({ providerSessionId: "fid" });
    const err = await adapter
      .uploadChunk(
        session,
        makeChunkMeta(0, 0, 512),
        new Uint8Array(512),
        "sha",
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransferError);
    expect((err as TransferError).category).toBe("rateLimit");
  });
});

// ── completeTransfer ──────────────────────────────────────────────────────────
describe("B2Adapter.completeTransfer", () => {
  it("calls b2_finish_large_file with sorted sha1 tokens", async () => {
    const fetchMock = mockFetch([
      { status: 200, json: AUTH_RESPONSE },
      { status: 200, json: {} }, // finish_large_file
    ]);
    const adapter = new B2Adapter({
      applicationKeyId: "k",
      applicationKey: "s",
      bucketId: "b",
      fetch: fetchMock,
    });
    const session = makeSession({ providerSessionId: "fid" });
    const chunks = [
      {
        ...makeChunkMeta(1, 1024, 1024),
        status: "done" as const,
        providerToken: "sha1-b",
      },
      {
        ...makeChunkMeta(0, 0, 1024),
        status: "done" as const,
        providerToken: "sha1-a",
      },
    ];
    await adapter.completeTransfer(session, chunks);
    const body = JSON.parse(
      (fetchMock.mock.calls[1]![1] as RequestInit).body as string,
    );
    expect(body.partSha1Array).toEqual(["sha1-a", "sha1-b"]); // sorted by index
  });
});

// ── abortTransfer ─────────────────────────────────────────────────────────────
describe("B2Adapter.abortTransfer", () => {
  it("calls b2_cancel_large_file", async () => {
    const adapter = makeAdapter([
      { status: 200, json: AUTH_RESPONSE },
      { status: 200, json: {} },
    ]);
    const session = makeSession({ providerSessionId: "fid" });
    await expect(adapter.abortTransfer(session)).resolves.not.toThrow();
  });

  it("is a no-op when providerSessionId is missing", async () => {
    const fetchMock = mockFetch([]);
    const adapter = new B2Adapter({
      applicationKeyId: "k",
      applicationKey: "s",
      bucketId: "b",
      fetch: fetchMock,
    });
    await adapter.abortTransfer(makeSession()); // no providerSessionId
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not throw even if cancel fails", async () => {
    const adapter = makeAdapter([
      { status: 200, json: AUTH_RESPONSE },
      { status: 500, text: "Internal error" },
    ]);
    const session = makeSession({ providerSessionId: "fid" });
    await expect(adapter.abortTransfer(session)).resolves.not.toThrow();
  });
});

// ── HTTP timeout ───────────────────────────────────────────────────────────────
describe("B2Adapter — HTTP timeout", () => {
  afterEach(() => jest.useRealTimers());

  it("throws a network error when a request stalls past timeoutMs", async () => {
    jest.useFakeTimers();

    // A fetch that hangs forever but aborts when the signal fires
    const hangingFetch = jest.fn().mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = (init as RequestInit & { signal?: AbortSignal })
            ?.signal;
          if (signal) {
            signal.addEventListener("abort", () => {
              const err = Object.assign(
                new Error("The operation was aborted"),
                {
                  name: "AbortError",
                },
              );
              reject(err);
            });
          }
        }),
    );

    const adapter = new B2Adapter({
      applicationKeyId: "k",
      applicationKey: "s",
      bucketId: "b",
      fetch: hangingFetch,
      timeoutMs: 1_000,
    });

    // Start the request (auth call, which also uses _fetchWithTimeout)
    const promise = adapter
      .initTransfer(makeSession())
      .catch((e: unknown) => e);

    // Advance fake clock past the timeout
    jest.advanceTimersByTime(1_100);

    const err = await promise;
    expect(err).toBeInstanceOf(TransferError);
    expect((err as TransferError).category).toBe("network");
    expect((err as TransferError).message).toContain("timed out");
  });

  it("succeeds when the request resolves before timeoutMs", async () => {
    jest.useFakeTimers();

    // Fetch resolves immediately (before timeout fires)
    const fastFetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: () => Promise.resolve(AUTH_RESPONSE),
      text: () => Promise.resolve(""),
    } as Response);

    const adapter = new B2Adapter({
      applicationKeyId: "k",
      applicationKey: "s",
      bucketId: "b",
      fetch: fastFetch,
      timeoutMs: 5_000,
    });

    // Mock the second call (startLargeFile) too
    fastFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: () => Promise.resolve(AUTH_RESPONSE),
        text: () => Promise.resolve(""),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: () => Promise.resolve({ fileId: "fid" }),
        text: () => Promise.resolve(""),
      } as Response);

    const result = await adapter.initTransfer(makeSession());
    expect(result).toBe("fid");
  });
});
