/**
 * @module S3Adapter
 *
 * AWS S3 (and S3-compatible) multipart upload adapter for TransferX.
 *
 * Multipart upload lifecycle:
 *
 *   1. CreateMultipartUpload  → UploadId  (stored as session.providerSessionId)
 *   2. UploadPart × N         → ETag      (stored as chunk.providerToken, verbatim
 *                                           with surrounding quotes, e.g. `"abc123"`)
 *   3. CompleteMultipartUpload → finalises the object
 *   (abort path: AbortMultipartUpload)
 *
 * Resume support:
 *   getRemoteState() calls ListParts (with pagination) to discover already-
 *   uploaded parts, so the engine can skip re-uploading them on resume.
 *
 * Cloudflare R2 / S3-compatible stores:
 *   Pass `endpoint` + `forcePathStyle: true` to target any S3-compatible API.
 *   See R2Adapter for a purpose-built Cloudflare R2 wrapper.
 *
 * Security notes:
 *   - Credentials are passed to the AWS SDK and NEVER logged or stored in
 *     instance fields accessible outside this module.
 *   - The AWS SDK's built-in retry mechanism is disabled (maxAttempts: 1) so
 *     that TransferX's retry engine is the single source of truth.
 *
 * ETag contract:
 *   S3 returns ETags surrounded by double-quotes (e.g. `"d8e8fca2dc0f896f"`).
 *   These are stored verbatim as chunk.providerToken and passed back verbatim
 *   in CompleteMultipartUpload — the AWS SDK serialises them correctly.
 *
 * Minimum part size:
 *   AWS S3 requires each non-final part to be ≥ 5 MiB. TransferX's default
 *   chunkSize (10 MiB) satisfies this. The engine enforces chunkSize ≥ 5 MiB
 *   through config validation; this adapter does not re-validate.
 */

import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  ListPartsCommand,
} from "@aws-sdk/client-s3";
import {
  TransferError,
  networkError,
  serverError,
  clientError,
  authError,
  rateLimitError,
} from "@transferx/core";
import type {
  ITransferAdapter,
  ChunkUploadResult,
  RemoteUploadState,
  LogLevel,
} from "@transferx/core";
import type { TransferSession, ChunkMeta } from "@transferx/core";

// ── Options ───────────────────────────────────────────────────────────────────

export interface S3AdapterOptions {
  /** Target S3 bucket name. */
  bucket: string;
  /**
   * AWS region (e.g. `"us-east-1"`).
   * Ignored when `endpoint` is set and the provider does not require a region
   * (e.g. Cloudflare R2 — use `"auto"` or omit).
   * Defaults to `"us-east-1"`.
   */
  region?: string;
  /**
   * AWS credentials. These are passed directly to the AWS SDK and never logged.
   * For Cloudflare R2: use the Access Key ID and Secret from an R2 API token.
   */
  credentials: {
    /** AWS Access Key ID (or R2 Access Key). */
    accessKeyId: string;
    /** AWS Secret Access Key (or R2 Secret). */
    secretAccessKey: string;
    /** AWS STS session token for temporary credentials. Omit for R2. */
    sessionToken?: string;
  };
  /**
   * Custom endpoint URL for S3-compatible storage providers.
   * Required for Cloudflare R2:
   *   `https://<account-id>.r2.cloudflarestorage.com`
   */
  endpoint?: string;
  /**
   * Use path-style URLs (`/bucket/key`) instead of virtual-hosted style
   * (`bucket.s3.amazonaws.com/key`).
   * Required for Cloudflare R2 and most non-AWS S3-compatible stores.
   * Default: `false`.
   */
  forcePathStyle?: boolean;
  /**
   * Per-request HTTP timeout in milliseconds. Any request that stalls beyond
   * this threshold is aborted and throws a retryable `network` error.
   * Default: `120_000` (2 minutes).
   */
  timeoutMs?: number;
  /**
   * Optional structured-log callback for observability.
   * `createS3Engine()` (if using the SDK façade) wires this automatically to
   * the shared EventBus; for manual use, pass `bus.emit` directly.
   *
   * @example
   * const adapter = new S3Adapter({
   *   ...,
   *   onLog: (level, msg, ctx) => bus.emit({ type: 'log', level, message: msg, ...ctx && { context: ctx } }),
   * });
   */
  onLog?: (
    level: LogLevel,
    message: string,
    context?: Record<string, unknown>,
  ) => void;
  /**
   * Inject a pre-built `S3Client` instance.
   * **For testing only** — pass a mock client to avoid real AWS calls.
   * When provided, all other connection options (`region`, `endpoint`, etc.)
   * are ignored.
   */
  client?: S3Client;
}

// ── Internal error shape (duck-typed from AWS SDK) ────────────────────────────

interface AwsSdkError {
  $metadata?: { httpStatusCode?: number };
  $response?: { headers?: Record<string, string> };
  message?: string;
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export class S3Adapter implements ITransferAdapter {
  /** @internal exposed as protected so R2Adapter can subclass. */
  protected readonly _client: S3Client;
  private readonly _bucket: string;
  private readonly _timeoutMs: number;
  private readonly _onLog: S3AdapterOptions["onLog"];

  constructor(opts: S3AdapterOptions) {
    this._bucket = opts.bucket;
    this._timeoutMs = opts.timeoutMs ?? 120_000;
    this._onLog = opts.onLog;

    if (opts.client) {
      // Injected client — used in tests; skip constructing a real one.
      this._client = opts.client;
    } else {
      // Disable SDK-level retries — TransferX owns the retry loop.
      const clientConfig: ConstructorParameters<typeof S3Client>[0] = {
        maxAttempts: 1,
        region: opts.region ?? "us-east-1",
        credentials: {
          accessKeyId: opts.credentials.accessKeyId,
          secretAccessKey: opts.credentials.secretAccessKey,
          // Conditionally include sessionToken — exactOptionalPropertyTypes safe.
          ...(opts.credentials.sessionToken !== undefined
            ? { sessionToken: opts.credentials.sessionToken }
            : {}),
        },
      };

      // Only set endpoint / forcePathStyle when explicitly provided. Setting
      // either to undefined would trigger AWS SDK default-resolution paths
      // that conflict with some S3-compatible providers.
      if (opts.endpoint !== undefined) {
        clientConfig.endpoint = opts.endpoint;
      }
      if (opts.forcePathStyle === true) {
        clientConfig.forcePathStyle = true;
      }

      this._client = new S3Client(clientConfig);
    }
  }

  // ── ITransferAdapter ───────────────────────────────────────────────────────

  async initTransfer(session: TransferSession): Promise<string> {
    const cmd = new CreateMultipartUploadCommand({
      Bucket: this._bucket,
      Key: session.targetKey,
      ContentType: session.file.mimeType || "application/octet-stream",
    });

    const output = await this._send<{ UploadId?: string }>(cmd, "initTransfer");

    const uploadId = output.UploadId;
    if (!uploadId) {
      throw new TransferError(
        "S3 CreateMultipartUpload did not return an UploadId",
        "serverError",
      );
    }

    this._onLog?.("info", "[S3] Multipart upload initiated", {
      sessionId: session.id,
      uploadId,
    });

    return uploadId;
  }

  async uploadChunk(
    session: TransferSession,
    chunk: ChunkMeta,
    data: Uint8Array,
    // sha256Hex intentionally unused: the engine handles local integrity checks.
    // S3 computes its own ETag (MD5) for server-side integrity verification.
    // Attaching ChecksumSHA256 would require coordinating ChecksumAlgorithm
    // on both CreateMultipartUpload and UploadPart — a future enhancement.
    _sha256Hex: string,
  ): Promise<ChunkUploadResult> {
    if (!session.providerSessionId) {
      throw new TransferError(
        "providerSessionId is missing — initTransfer must be called first",
        "fatal",
      );
    }

    // S3 part numbers are 1-based (range: 1–10,000).
    const partNumber = chunk.index + 1;

    const cmd = new UploadPartCommand({
      Bucket: this._bucket,
      Key: session.targetKey,
      UploadId: session.providerSessionId,
      PartNumber: partNumber,
      Body: data,
    });

    const output = await this._send<{ ETag?: string }>(
      cmd,
      "uploadChunk",
      chunk.index,
    );

    const etag = output.ETag;
    if (!etag) {
      throw new TransferError(
        `S3 UploadPart for part ${partNumber} returned no ETag`,
        "serverError",
      );
    }

    // Store ETag verbatim — AWS returns it with surrounding double-quotes
    // (e.g. `"d8e8fca2dc0f896fd7cb4cb0031ba249"`).  CompleteMultipartUpload
    // requires ETags in the same format, so we must NOT strip the quotes here.
    return { providerToken: etag };
  }

  async completeTransfer(
    session: TransferSession,
    chunks: ChunkMeta[],
  ): Promise<void> {
    if (!session.providerSessionId) {
      throw new TransferError(
        "providerSessionId missing in completeTransfer",
        "fatal",
      );
    }

    // S3 requires Parts sorted ascending by PartNumber; do so defensively even
    // if the engine already delivers them in order.
    const sortedParts = [...chunks]
      .sort((a, b) => a.index - b.index)
      .map((c) => ({
        PartNumber: c.index + 1,
        ETag: c.providerToken ?? "",
      }));

    const cmd = new CompleteMultipartUploadCommand({
      Bucket: this._bucket,
      Key: session.targetKey,
      UploadId: session.providerSessionId,
      MultipartUpload: { Parts: sortedParts },
    });

    await this._send<object>(cmd, "completeTransfer");

    this._onLog?.("info", "[S3] Multipart upload completed", {
      sessionId: session.id,
      partCount: sortedParts.length,
    });
  }

  async abortTransfer(session: TransferSession): Promise<void> {
    if (!session.providerSessionId) return;
    try {
      const cmd = new AbortMultipartUploadCommand({
        Bucket: this._bucket,
        Key: session.targetKey,
        UploadId: session.providerSessionId,
      });
      await this._send<object>(cmd, "abortTransfer");
    } catch {
      // Best-effort — swallow errors so cancel/fail never blocks the engine.
    }
  }

  async getRemoteState(session: TransferSession): Promise<RemoteUploadState> {
    if (!session.providerSessionId) {
      return { uploadedParts: [] };
    }

    const uploadedParts: RemoteUploadState["uploadedParts"] = [];

    // S3 paginates ListParts via PartNumberMarker / NextPartNumberMarker.
    // IsTruncated === true means there are more pages.
    let partNumberMarker: number | string | undefined;
    do {
      const cmdInput: ConstructorParameters<typeof ListPartsCommand>[0] = {
        Bucket: this._bucket,
        Key: session.targetKey,
        UploadId: session.providerSessionId,
        MaxParts: 1000,
      };
      if (partNumberMarker !== undefined) {
        // ListPartsCommandInput.PartNumberMarker is typed as string in the
        // AWS SDK even though S3's API uses an integer marker value.
        cmdInput.PartNumberMarker = String(partNumberMarker);
      }

      const output = await this._send<{
        Parts?: Array<{ PartNumber?: number; ETag?: string }>;
        IsTruncated?: boolean;
        NextPartNumberMarker?: number | string;
      }>(new ListPartsCommand(cmdInput), "getRemoteState");

      for (const part of output.Parts ?? []) {
        if (part.PartNumber != null && part.ETag) {
          uploadedParts.push({
            partNumber: part.PartNumber,
            providerToken: part.ETag,
          });
        }
      }

      partNumberMarker =
        output.IsTruncated === true && output.NextPartNumberMarker != null
          ? output.NextPartNumberMarker
          : undefined;
    } while (partNumberMarker !== undefined);

    return { uploadedParts };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Send an S3 command with a per-request AbortController timeout and unified
   * error mapping.  The return type is cast to `T` — callers know the shape of
   * each command's output.
   *
   * The `command` parameter is typed as `unknown` here because AWS SDK v3
   * Command classes are generic and contravariant — assigning a specific
   * `CreateMultipartUploadCommand` to `Command<ServiceInputTypes, ...>` fails
   * TypeScript's structural check due to middlewareStack overloads.  Each call
   * site already supplies the correctly-typed Command, so the cast is safe.
   */
  private async _send<T>(
    command: unknown,
    op: string,
    chunkIndex?: number,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this._timeoutMs);
    try {
      return (await (
        this._client.send as unknown as (
          cmd: unknown,
          opts: { abortSignal: AbortSignal },
        ) => Promise<T>
      )(command, { abortSignal: controller.signal })) as T;
    } catch (err) {
      throw this._mapError(err, op, chunkIndex);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Normalise any error thrown by the AWS SDK into a typed TransferError so the
   * engine can make correct retry/abort decisions.
   */
  private _mapError(
    err: unknown,
    op: string,
    chunkIndex?: number,
  ): TransferError {
    // AbortController fired → request timed out.
    if (err instanceof Error && err.name === "AbortError") {
      return networkError(
        `[S3] ${op} timed out after ${this._timeoutMs}ms`,
        err,
        chunkIndex,
      );
    }

    // AWS SDK v3 service exceptions carry $metadata.httpStatusCode.
    // Duck-type to avoid importing the (internal) base exception class.
    const sdkErr = err as AwsSdkError;
    const status = sdkErr.$metadata?.httpStatusCode ?? 0;
    const msg = err instanceof Error ? err.message : String(err);
    const retryAfterHeader = sdkErr.$response?.headers?.["retry-after"];

    if (status === 401 || status === 403) {
      this._onLog?.("warn", `[S3] ${op} authorisation error (HTTP ${status})`, {
        chunkIndex,
      });
      return authError(`S3 ${status}: ${msg}`);
    }
    if (status === 429) {
      const retryAfterMs = retryAfterHeader
        ? parseInt(retryAfterHeader, 10) * 1000
        : undefined;
      return rateLimitError(retryAfterMs);
    }
    if (status >= 500) {
      return serverError(status, msg);
    }
    if (status >= 400) {
      return clientError(status, msg);
    }

    // No HTTP status — treat as a transient network failure.
    if (err instanceof Error) {
      return networkError(
        `[S3] ${op} request failed: ${err.message}`,
        err,
        chunkIndex,
      );
    }
    return new TransferError(String(err), "unknown", err, chunkIndex);
  }
}
