import { randomUUID } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { config } from "../shared/config";
import type { CheckResult } from "./types";

type StaticValidation = {
  errors: string[];
  warnings: string[];
  hints: string[];
  details: Record<string, unknown>;
  isR2: boolean;
};

function hasValue(value: string | undefined) {
  return typeof value === "string" && value.trim().length > 0;
}

function resolveCredentialSources() {
  const accessKeySource = hasValue(process.env.AWS_ACCESS_KEY_ID)
    ? "AWS_ACCESS_KEY_ID"
    : hasValue(process.env.S3_ACCESS_KEY_ID)
      ? "S3_ACCESS_KEY_ID"
      : null;
  const secretKeySource = hasValue(process.env.AWS_SECRET_ACCESS_KEY)
    ? "AWS_SECRET_ACCESS_KEY"
    : hasValue(process.env.S3_SECRET_ACCESS_KEY)
      ? "S3_SECRET_ACCESS_KEY"
      : null;

  return {
    accessKeySource,
    secretKeySource,
    hasAwsCredentials: hasValue(process.env.AWS_ACCESS_KEY_ID) ||
      hasValue(process.env.AWS_SECRET_ACCESS_KEY),
    hasS3Credentials: hasValue(process.env.S3_ACCESS_KEY_ID) ||
      hasValue(process.env.S3_SECRET_ACCESS_KEY),
  };
}

function addR2Hints(hints: string[]) {
  hints.push(
    "Use R2 S3 Access Key ID and Secret Access Key, not a Cloudflare API token.",
    "S3_ENDPOINT for R2 should be https://<account-id>.r2.cloudflarestorage.com without the bucket path.",
    "Set S3_REGION=auto and S3_FORCE_PATH_STYLE=true for Cloudflare R2.",
    "Clear AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY if you intend to use S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY.",
  );
}

function validateStorageConfig(): StaticValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const hints: string[] = [];
  const credentials = resolveCredentialSources();
  const details: Record<string, unknown> = {
    bucket: config.s3.bucket || null,
    region: config.s3.region,
    endpoint: config.s3.endpoint || null,
    forcePathStyle: config.s3.forcePathStyle,
    accessKeySource: credentials.accessKeySource,
    secretKeySource: credentials.secretKeySource,
  };
  let isR2 = false;

  if (!config.s3.bucket) {
    errors.push("S3_BUCKET is not configured.");
  }

  if (!credentials.accessKeySource || !credentials.secretKeySource) {
    errors.push("S3 credentials are incomplete.");
    hints.push("Set S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY, or set both AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.");
  }

  if (
    credentials.accessKeySource &&
    credentials.secretKeySource &&
    credentials.accessKeySource.split("_")[0] !== credentials.secretKeySource.split("_")[0]
  ) {
    errors.push("S3 access key and secret key are resolved from different env namespaces.");
    hints.push("Use either AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY or S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY consistently.");
  }

  if (credentials.hasAwsCredentials && credentials.hasS3Credentials) {
    warnings.push("Both AWS_* and S3_* credentials are present; AWS_* values take precedence in backend config.");
    hints.push("Unset AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY if they are not intended for source storage.");
  }

  if (config.s3.endpoint) {
    try {
      const endpointUrl = new URL(config.s3.endpoint);
      isR2 = endpointUrl.hostname.endsWith(".r2.cloudflarestorage.com");
      details.endpointHost = endpointUrl.hostname;
      details.endpointPath = endpointUrl.pathname;

      if (endpointUrl.pathname && endpointUrl.pathname !== "/") {
        errors.push("S3_ENDPOINT must not include a bucket name or path.");
        hints.push("Move the bucket name to S3_BUCKET and keep S3_ENDPOINT as the provider base URL.");
      }

      if (isR2) {
        if (config.s3.region !== "auto") {
          warnings.push("Cloudflare R2 is usually configured with S3_REGION=auto.");
        }
        if (!config.s3.forcePathStyle) {
          warnings.push("Cloudflare R2 should use S3_FORCE_PATH_STYLE=true for this S3 client configuration.");
        }
        addR2Hints(hints);
      }
    } catch {
      errors.push("S3_ENDPOINT is not a valid URL.");
    }
  }

  return {
    errors,
    warnings,
    hints: Array.from(new Set(hints)),
    details,
    isR2,
  };
}

function createS3Client() {
  return new S3Client({
    region: config.s3.region,
    credentials:
      config.s3.accessKeyId && config.s3.secretAccessKey
        ? {
            accessKeyId: config.s3.accessKeyId,
            secretAccessKey: config.s3.secretAccessKey,
          }
        : undefined,
    endpoint: config.s3.endpoint || undefined,
    forcePathStyle: config.s3.forcePathStyle,
  });
}

function describeStorageError(error: unknown, isR2: boolean) {
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const name = typeof record.name === "string" ? record.name : "StorageError";
  const message = error instanceof Error ? error.message : String(error);
  const metadata = record.$metadata && typeof record.$metadata === "object"
    ? (record.$metadata as Record<string, unknown>)
    : {};
  const hints: string[] = [];

  if (["Unauthorized", "AccessDenied", "InvalidAccessKeyId", "SignatureDoesNotMatch"].includes(name)) {
    hints.push("Check source storage credentials and bucket permissions for PutObject/GetObject/DeleteObject.");
    if (isR2) {
      addR2Hints(hints);
    }
  }

  if (name === "NoSuchBucket") {
    hints.push("Check that S3_BUCKET exists and belongs to the configured endpoint/account.");
  }

  return {
    name,
    message,
    httpStatusCode: metadata.httpStatusCode,
    hints: Array.from(new Set(hints)),
  };
}

export async function runStorageCheck(): Promise<CheckResult> {
  const startedAt = Date.now();
  const validation = validateStorageConfig();

  if (validation.errors.length > 0) {
    return {
      name: "storage",
      status: "error",
      message: validation.errors.join(" "),
      details: {
        ...validation.details,
        warnings: validation.warnings,
      },
      hints: validation.hints,
      durationMs: Date.now() - startedAt,
    };
  }

  const client = createS3Client();
  const key = `health/sourceweft-check/${Date.now()}-${randomUUID()}.txt`;
  const body = `sourceweft storage check ${randomUUID()}`;
  let putSucceeded = false;

  try {
    await client.send(
      new PutObjectCommand({
        Bucket: config.s3.bucket,
        Key: key,
        Body: body,
        ContentType: "text/plain; charset=utf-8",
      }),
    );
    putSucceeded = true;

    const response = await client.send(
      new GetObjectCommand({
        Bucket: config.s3.bucket,
        Key: key,
      }),
    );
    const bytes = await response.Body?.transformToByteArray();
    const readBody = Buffer.from(bytes ?? []).toString("utf8");

    if (readBody !== body) {
      return {
        name: "storage",
        status: "error",
        message: "Source storage GetObject returned unexpected content.",
        details: validation.details,
        hints: ["Check whether the configured bucket/endpoint points to the expected object store."],
        durationMs: Date.now() - startedAt,
      };
    }

    await client.send(
      new DeleteObjectCommand({
        Bucket: config.s3.bucket,
        Key: key,
      }),
    );

    return {
      name: "storage",
      status: validation.warnings.length > 0 ? "warn" : "ok",
      message: "PutObject/GetObject/DeleteObject succeeded for source storage.",
      details: {
        ...validation.details,
        probeKeyPrefix: "health/sourceweft-check/",
        warnings: validation.warnings,
      },
      hints: validation.hints,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    const described = describeStorageError(error, validation.isR2);

    if (putSucceeded) {
      await client.send(
        new DeleteObjectCommand({
          Bucket: config.s3.bucket,
          Key: key,
        }),
      ).catch(() => undefined);
    }

    return {
      name: "storage",
      status: "error",
      message: `Source storage probe failed (${described.name}): ${described.message}`,
      details: {
        ...validation.details,
        errorName: described.name,
        httpStatusCode: described.httpStatusCode,
        warnings: validation.warnings,
      },
      hints: Array.from(new Set([...validation.hints, ...described.hints])),
      durationMs: Date.now() - startedAt,
    };
  }
}
