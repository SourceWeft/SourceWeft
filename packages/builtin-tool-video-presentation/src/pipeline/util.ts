import {
  extensionForMimeType,
  sanitizeArtifactStorageSegment,
} from "@sourceweft/contracts/artifact-files";
import { VIDEO_PRESENTATION_FILE_BASE_FALLBACK } from "../video-presentation-files";
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

export function normalizeProjectExecutionResults<
  TVideo = { data: Uint8Array; report: unknown },
>(input: {
  install: ProjectExecutionResult;
  typecheck: ProjectExecutionResult;
  smoke: ProjectExecutionResult;
  stills?: Array<{ slideNumber: number; data: Uint8Array }>;
  video?: TVideo;
}) {
  return {
    install: truncateProjectExecutionResult(input.install),
    typecheck: truncateProjectExecutionResult(input.typecheck),
    smoke: truncateProjectExecutionResult(input.smoke),
    stills: input.stills ?? [],
    // Binary render output passes through untouched — truncation applies to
    // diagnostics, never to bytes. Absent unless the opt-in mp4 render ran.
    ...(input.video ? { video: input.video } : {}),
  };
}

/**
 * ASCII-only segment for storage keys, sandbox directory names, job ids and
 * tool-call ids. These are the video pipeline's genuinely ASCII-bound values —
 * user-visible file names use `sanitizeVideoPresentationFileBase`, which keeps
 * unicode.
 */
export function safeStorageSegment(value: string) {
  return sanitizeArtifactStorageSegment(value, {
    fallback: VIDEO_PRESENTATION_FILE_BASE_FALLBACK,
    maxLength: 80,
  });
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

/**
 * Extension (with leading dot) for a rendered still or fetched asset.
 *
 * This used to match by substring, which classified anything merely containing
 * "gif" — `application/x-gif-thing` — as a GIF. Matching is exact now and
 * unknown types fall back to `.jpg`, which is what the sandbox renderer emits.
 */
export function imageExtensionForMimeType(mimeType: string | undefined | null) {
  return extensionForMimeType(mimeType, ".jpg");
}
