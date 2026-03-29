/**
 * @module R2Adapter
 *
 * Cloudflare R2 multipart upload adapter for TransferX.
 *
 * R2 is S3-compatible but requires three non-standard settings:
 *
 *   1. Custom endpoint:    `https://<accountId>.r2.cloudflarestorage.com`
 *   2. forcePathStyle:     `true`  — avoids virtual-hosted DNS issues with R2
 *   3. Region:             `"auto"` — R2 ignores region; AWS SDK requires a value
 *
 * All multipart upload semantics (5 MiB min part size, ETag tracking,
 * ListParts-based resume, sorted CompleteMultipartUpload) are inherited
 * from S3Adapter.
 *
 * @example
 * ```typescript
 * import { R2Adapter } from '@transferx/adapter-s3';
 *
 * const adapter = new R2Adapter({
 *   accountId:   process.env.CF_ACCOUNT_ID!,
 *   bucket:      'my-r2-bucket',
 *   credentials: {
 *     accessKeyId:     process.env.R2_ACCESS_KEY_ID!,
 *     secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
 *   },
 * });
 * ```
 */

import type { S3Client } from "@aws-sdk/client-s3";
import type { LogLevel } from "@transferx/core";
import { S3Adapter, type S3AdapterOptions } from "./S3Adapter.js";

// ── Options ───────────────────────────────────────────────────────────────────

export interface R2AdapterOptions {
  /**
   * Cloudflare account ID.
   * Found in the Cloudflare dashboard URL: `dash.cloudflare.com/<accountId>`.
   */
  accountId: string;
  /** R2 bucket name. */
  bucket: string;
  /**
   * R2 API credentials. Generate from Cloudflare Dashboard → R2 → Manage API tokens.
   * These are **never** logged.
   */
  credentials: {
    /** R2 Access Key ID. */
    accessKeyId: string;
    /** R2 Secret Access Key. */
    secretAccessKey: string;
  };
  /**
   * Per-request HTTP timeout in milliseconds.
   * Default: `120_000` (2 minutes).
   */
  timeoutMs?: number;
  /**
   * Optional structured-log callback. Wire to the engine's EventBus for
   * end-to-end observability.
   */
  onLog?: (
    level: LogLevel,
    message: string,
    context?: Record<string, unknown>,
  ) => void;
  /**
   * Inject a pre-built `S3Client` instance.
   * **For testing only.**
   */
  client?: S3Client;
}

// ── Adapter ───────────────────────────────────────────────────────────────────

/**
 * R2Adapter delegates all work to S3Adapter, injecting the R2-specific
 * connection settings in the constructor.  No R2-specific overrides are needed
 * beyond those three config values.
 */
export class R2Adapter extends S3Adapter {
  constructor(opts: R2AdapterOptions) {
    const s3Opts: S3AdapterOptions = {
      bucket: opts.bucket,
      // R2 does not enforce region routing but the AWS SDK requires a value.
      region: "auto",
      // Construct the R2 account-specific endpoint.
      endpoint: `https://${opts.accountId}.r2.cloudflarestorage.com`,
      // Path-style addressing is required to avoid virtual-hosted DNS issues.
      forcePathStyle: true,
      credentials: {
        accessKeyId: opts.credentials.accessKeyId,
        secretAccessKey: opts.credentials.secretAccessKey,
      },
      // Forward optional fields only when present (exactOptionalPropertyTypes).
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.onLog !== undefined ? { onLog: opts.onLog } : {}),
      ...(opts.client !== undefined ? { client: opts.client } : {}),
    };
    super(s3Opts);
  }
}
