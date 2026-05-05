import { createHash } from "node:crypto";
import { redactValue } from "./redaction";
import { toJsonSafe } from "./serializers";
import type { AuditPayloadMode } from "./types";

export const DEFAULT_AUDIT_PAYLOAD_MODE: AuditPayloadMode = "preview";
export const DEFAULT_MAX_JSON_BYTES = 64 * 1024;
export const DEFAULT_PREVIEW_CHARS = 4000;
export const DEFAULT_FULL_PAYLOAD_RETENTION_DAYS = 30;
export const DEFAULT_METADATA_RETENTION_DAYS = 90;

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function byteLength(value: string) {
  return Buffer.byteLength(value, "utf8");
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function getValueType(value: unknown) {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

function trimJsonString(json: string, maxBytes: number) {
  if (byteLength(json) <= maxBytes) {
    return { json, truncated: false };
  }

  let trimmed = json.slice(0, maxBytes);
  while (byteLength(trimmed) > maxBytes && trimmed.length > 0) {
    trimmed = trimmed.slice(0, -1);
  }
  return { json: trimmed, truncated: true };
}

export function applyPayloadPolicy(input: {
  value: unknown;
  mode?: AuditPayloadMode;
  maxJsonBytes?: number;
  previewChars?: number;
}): Record<string, unknown> | null {
  const mode = input.mode ?? DEFAULT_AUDIT_PAYLOAD_MODE;
  const maxJsonBytes = input.maxJsonBytes ?? DEFAULT_MAX_JSON_BYTES;
  const previewChars = input.previewChars ?? DEFAULT_PREVIEW_CHARS;
  const redacted = redactValue(toJsonSafe(input.value));
  const serialized = stableStringify(redacted);
  const length = byteLength(serialized);
  const digest = sha256(serialized);
  const type = getValueType(redacted);

  if (mode === "metadata_only") {
    return {
      redacted: true,
      mode,
      type,
      length,
      sha256: digest,
    };
  }

  if (mode === "preview") {
    const preview = serialized.slice(0, previewChars);
    return {
      mode,
      preview,
      length,
      sha256: digest,
      truncated: serialized.length > preview.length,
    };
  }

  const trimmed = trimJsonString(serialized, maxJsonBytes);
  if (trimmed.truncated) {
    return {
      mode,
      preview: trimmed.json,
      length,
      sha256: digest,
      truncated: true,
    };
  }

  return {
    mode,
    value: redacted,
    length,
    sha256: digest,
    truncated: false,
  };
}

export function applyPayloadPolicyToRecord(
  value: unknown,
  mode?: AuditPayloadMode,
): Record<string, unknown> | null {
  return applyPayloadPolicy({ value, mode });
}
