/**
 * B2Adapter unit tests — no network calls.
 * All HTTP is intercepted via a mock `fetch` injected in the constructor.
 */
import { B2Adapter } from "../src/B2Adapter";
import type { TransferSession } from "@transferx/core";
import { makeChunkMeta, TransferError } from "@transferx/core";

// ── Mock helpers ───────────────────────────────────────────────────────────

function mockFetch(
  responses: Array<{ status: number; json?: unknown; text?: string }>,
) {
  let index = 0;
  return jest.fn().mockImplementation(() => {
    const r = responses[index++];
    if (!r) throw new Error("Unexpected extra fetch call");
    return Promise.resolve({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: new Headers(),
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

  it("re-authorises and throws authError on 401 from upload", async () => {
    const adapter = makeAdapter([
      { status: 200, json: AUTH_RESPONSE },
      { status: 200, json: GET_UPLOAD_PART_URL_RESPONSE },
      { status: 401, text: "Unauthorised" },
    ]);
    const session = makeSession({ providerSessionId: "fid" });
    await expect(
      adapter.uploadChunk(
        session,
        makeChunkMeta(0, 0, 512),
        new Uint8Array(512),
        "sha",
      ),
    ).rejects.toBeInstanceOf(TransferError);
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
