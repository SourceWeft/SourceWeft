import { MAX_DIAGNOSTIC_LENGTH } from "./config";
import type { ProjectExecutionResult } from "./deps";

export function toObjectRecordOrUndefined(
  value: unknown,
): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function truncateText(value: string, maxLength: number) {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

export function truncateDiagnostics(diagnostics: readonly string[]) {
  return diagnostics
    .map((diagnostic) => truncateText(diagnostic.trim(), MAX_DIAGNOSTIC_LENGTH))
    .filter(Boolean);
}

export function truncateProjectExecutionResult(
  result: ProjectExecutionResult,
): ProjectExecutionResult {
  return {
    ...result,
    diagnostics: truncateDiagnostics(result.diagnostics),
    ...(typeof result.stdout === "string"
      ? { stdout: truncateText(result.stdout, 10_000) }
      : {}),
    ...(typeof result.stderr === "string"
      ? { stderr: truncateText(result.stderr, 10_000) }
      : {}),
  };
}

export function normalizeProjectExecutionResults(input: {
  install: ProjectExecutionResult;
  typecheck: ProjectExecutionResult;
  smoke: ProjectExecutionResult;
  stills?: Array<{ slideNumber: number; data: Uint8Array }>;
}) {
  return {
    install: truncateProjectExecutionResult(input.install),
    typecheck: truncateProjectExecutionResult(input.typecheck),
    smoke: truncateProjectExecutionResult(input.smoke),
    stills: input.stills ?? [],
  };
}

export function safeStorageSegment(value: string) {
  return (
    value
      .normalize("NFKC")
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "video-presentation"
  );
}

export function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** URL a published artifact asset is served from (same route audio uses). */
export function artifactAssetUrl(input: {
  artifactId: string;
  fileName: string;
  workspaceId: string;
}) {
  return `/v1/workspaces/${encodeURIComponent(input.workspaceId)}/artifacts/${encodeURIComponent(input.artifactId)}/assets/${encodeURIComponent(input.fileName)}`;
}

export function imageExtensionForMimeType(mimeType: string) {
  if (mimeType.includes("png")) return "png";
  if (mimeType.includes("webp")) return "webp";
  if (mimeType.includes("gif")) return "gif";
  if (mimeType.includes("svg")) return "svg";
  return "jpg";
}
