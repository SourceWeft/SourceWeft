import { isContentError } from "../content/errors";
import type { SourceParseJobPayload } from "../content/queue";
import type { SourceRecord } from "../content/types";

function metadataString(
  metadata: SourceRecord["metadata"],
  key: string,
): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.trim().length > 0
    ? value
    : null;
}

function externalUriHost(externalUri: string | null): string | null {
  if (!externalUri) {
    return null;
  }

  try {
    return new URL(externalUri).hostname;
  } catch {
    return "invalid_url";
  }
}

export function buildSourceParseLogContext(input: {
  job: SourceParseJobPayload;
  source: SourceRecord;
}) {
  const { job, source } = input;
  return {
    sourceId: source.id,
    sourceRevisionId: job.sourceRevisionId,
    workspaceId: job.workspaceId,
    teamId: job.teamId,
    sourceType: source.sourceType,
    ingestKind: source.ingestKind,
    status: source.status,
    mimeType: source.mimeType,
    parserVersion: source.parserVersion,
    hasExternalUri: Boolean(source.externalUri),
    externalUriHost: externalUriHost(source.externalUri),
    hasStorageBucket: Boolean(source.storageBucket),
    hasStorageKey: Boolean(source.storageKey),
    hasContentHash: Boolean(source.contentHash),
    sizeBytes: source.sizeBytes,
    idempotencyKey: job.idempotencyKey ?? null,
    forceRefresh: job.forceRefresh === true,
    metadataFileName: metadataString(source.metadata, "fileName"),
    metadataParserId: metadataString(source.metadata, "parserId"),
    metadataLoaderId: metadataString(source.metadata, "loaderId"),
    metadataUploadMethod: metadataString(source.metadata, "uploadMethod"),
  };
}

export function buildSourceParseErrorLogContext(error: unknown) {
  const context: Record<string, unknown> = {
    error: error instanceof Error ? error.message : "Source parse failed",
    errorName: error instanceof Error ? error.name : typeof error,
  };

  if (isContentError(error)) {
    context.errorCode = error.code;
    context.errorStatusCode = error.statusCode;
  }

  return context;
}

export function buildSourceParseFailureError(input: {
  source: SourceRecord;
  error: unknown;
}) {
  const { source, error } = input;
  const failure: Record<string, unknown> = {
    message: error instanceof Error ? error.message : "Source parse failed",
    sourceContext: {
      sourceType: source.sourceType,
      ingestKind: source.ingestKind,
      mimeType: source.mimeType,
      hasExternalUri: Boolean(source.externalUri),
      externalUriHost: externalUriHost(source.externalUri),
      hasStorageBucket: Boolean(source.storageBucket),
      hasStorageKey: Boolean(source.storageKey),
      metadataParserId: metadataString(source.metadata, "parserId"),
      metadataLoaderId: metadataString(source.metadata, "loaderId"),
    },
  };

  if (isContentError(error)) {
    failure.code = error.code;
    failure.statusCode = error.statusCode;
  }

  return failure;
}
