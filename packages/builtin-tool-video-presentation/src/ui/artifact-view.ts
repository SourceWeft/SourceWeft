/**
 * How this capability's tool output and artifact payload are read back for
 * display.
 *
 * The output keys, the stage words and the "is it finished?" rules below are
 * `generate_video_presentation`'s own wire vocabulary. They are decoded here,
 * beside the tool that writes them, so no generic renderer has to know them —
 * and so the message-stream card and the preview panel cannot describe the same
 * job two different ways.
 *
 * React-free on purpose: the block, the preview panel and the tests all share
 * these readers.
 */
import type { ArtifactPreviewRecord } from "@sourceweft/contracts/artifact-ui";
import { videoPresentationArtifactProtocol } from "../artifact-protocol";
import { videoPresentationPresentation } from "../presentation";
import { VIDEO_PRESENTATION_ARTIFACT_TYPE } from "../artifact-view";

/** Reads one scalar field out of a tool call's output, however it arrived. */
export type ToolOutputFieldReader = (key: string) => string | null;

export type VideoPresentationArtifactStatus =
  | "pending"
  | "running"
  | "ready"
  | "failed"
  | "archived";

export type VideoPresentationArtifactRef = {
  artifactId: string | null;
  artifactUrl: string | null;
  sourceJsonUrl: string | null;
  status: VideoPresentationArtifactStatus | null;
  title: string | null;
};

export type VideoPresentationToolCallView = {
  readonly input: Record<string, unknown>;
  readonly output: unknown;
};

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function trimmed(value: unknown) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

// ---------------------------------------------------------------------------
// Stage words
// ---------------------------------------------------------------------------

/**
 * The words for one stage id, as this capability's own presentation words them.
 * Going through `stageStep` rather than the raw label table is deliberate: the
 * presentation is what every other surface (streamed trace, persisted pipeline
 * steps) reads, and it also supplies the shared stage ids every deliverable
 * reports (`preparing`, `retrying`, `failed`).
 */
export function getVideoPresentationStageWords(
  stageId: string | null | undefined,
) {
  return stageId
    ? (videoPresentationPresentation.stageStep?.({ stageId })?.item ?? null)
    : null;
}

function readGeneration(payload: Record<string, unknown> | undefined) {
  return payload ? toRecord(payload.generation) : null;
}

/** The stage words for an artifact payload, or null when it reports no stage. */
export function getVideoPresentationPayloadStageWords(
  payload: Record<string, unknown> | undefined,
) {
  const generation = readGeneration(payload);
  return getVideoPresentationStageWords(
    typeof generation?.stage === "string" ? generation.stage : null,
  );
}

/**
 * Stage copy with this capability's own fallbacks applied — what a surface
 * shows while the job is preparing and has not reported a stage yet.
 */
export function resolveVideoProjectStageLabel(
  payload: Record<string, unknown>,
) {
  return (
    getVideoPresentationPayloadStageWords(payload) ??
    getVideoPresentationStageWords("preparing") ??
    ""
  );
}

// ---------------------------------------------------------------------------
// Terminal-state rules
// ---------------------------------------------------------------------------

export function isVideoPresentationFailed(input: {
  artifactStatus: string;
  payload: Record<string, unknown>;
}) {
  const generation = toRecord(input.payload.generation);
  return input.artifactStatus === "failed" || generation?.status === "failed";
}

/**
 * Browser preview and browser export share one gate: every generated scene
 * module must have compiled. A partially compiled project would play and export
 * with silently missing slides.
 */
export function canRenderVideoPresentationScenes(input: {
  compiledSceneCount: number;
  diagnosticCount: number;
  isCompilingScenes: boolean;
  isPreparing: boolean;
  sceneModuleCount: number;
  slideCount: number;
}) {
  return (
    !input.isPreparing &&
    !input.isCompilingScenes &&
    input.diagnosticCount === 0 &&
    input.sceneModuleCount === input.slideCount &&
    input.compiledSceneCount === input.slideCount
  );
}

// ---------------------------------------------------------------------------
// Tool-output decoding
// ---------------------------------------------------------------------------

function normalizeArtifactStatus(
  value: string | null,
): VideoPresentationArtifactStatus | null {
  const normalized = value?.toLowerCase();
  if (
    normalized === "pending" ||
    normalized === "running" ||
    normalized === "ready" ||
    normalized === "failed" ||
    normalized === "archived"
  ) {
    return normalized;
  }
  if (normalized === "queued") {
    return "pending";
  }
  if (normalized === "generating" || normalized === "rendering") {
    return "running";
  }
  if (normalized === "completed" || normalized === "success") {
    return "ready";
  }
  if (normalized === "error") {
    return "failed";
  }
  return null;
}

/**
 * The artifact reference `generate_video_presentation` publishes in its tool
 * output. The caller supplies the transport-level field reader (a host
 * facility); the *key names* and the structured-output gate are this
 * capability's business.
 *
 * The gate matters: this tool also emits plain conversational output, and only
 * its structured progress/result records describe an artifact card.
 */
export function resolveVideoPresentationArtifactRef(input: {
  metadata?: Record<string, unknown> | undefined;
  output: unknown;
  readField: ToolOutputFieldReader;
}): VideoPresentationArtifactRef | null {
  if (!videoPresentationArtifactProtocol.matchesOutputType(input.output)) {
    return null;
  }

  const metadata = input.metadata;
  const artifactId =
    trimmed(metadata?.artifactId) ??
    input.readField("artifact_id") ??
    input.readField("artifactId");
  const artifactUrl =
    trimmed(metadata?.artifactUrl) ??
    input.readField("artifact_url") ??
    input.readField("artifactUrl");
  const title = input.readField("title") ?? trimmed(metadata?.title);

  if (!artifactId && !artifactUrl) {
    return null;
  }

  return {
    artifactId: artifactId || null,
    artifactUrl: artifactUrl || null,
    sourceJsonUrl: input.readField("source_json_url"),
    status: normalizeArtifactStatus(input.readField("status")),
    title: title || null,
  };
}

/** The title to show, preferring what the run reported over what was asked for. */
export function getVideoPresentationToolCallTitle(
  toolCall: VideoPresentationToolCallView,
) {
  return (
    trimmed(toRecord(toolCall.output)?.title) ?? trimmed(toolCall.input.title)
  );
}

/** The one-line description under the title: the brief that started the run. */
export function getVideoPresentationToolCallBrief(
  toolCall: VideoPresentationToolCallView,
) {
  return (
    trimmed(toolCall.input.brief) ?? trimmed(toRecord(toolCall.output)?.prompt)
  );
}

// ---------------------------------------------------------------------------
// The in-trace artifact row
// ---------------------------------------------------------------------------

/**
 * The artifact row the card hands to the preview panel before the stored row
 * has necessarily been fetched.
 *
 * A video presentation is never file-backed — there is no server-rendered mp4 —
 * so it advertises no download and no open, only client-side rendering once the
 * project is ready.
 */
export function buildVideoPresentationPreviewRecord(input: {
  artifactId: string | null;
  description?: string | null;
  previewUrl: string | null;
  status: VideoPresentationArtifactStatus | null;
  title: string | null;
  workspaceId?: string | null;
}): ArtifactPreviewRecord | null {
  if (!input.artifactId || !input.workspaceId) {
    return null;
  }

  const status = input.status ?? "pending";
  const now = new Date().toISOString();

  return {
    id: input.artifactId,
    teamId: "",
    workspaceId: input.workspaceId,
    threadId: null,
    artifactType: VIDEO_PRESENTATION_ARTIFACT_TYPE,
    status,
    title: input.title,
    promptText: input.description ?? null,
    payloadJson: {
      artifactKind: VIDEO_PRESENTATION_ARTIFACT_TYPE,
      videoDownloadOnly: true,
    },
    storageBucket: null,
    storageKey: input.artifactId,
    previewStorageKey: null,
    previewMetadataJson: {},
    errorCode: null,
    errorMessage: null,
    createdBy: null,
    completedAt: status === "ready" ? now : null,
    createdAt: now,
    updatedAt: now,
    previewUrl: input.previewUrl,
    capabilities: {
      canDownloadFile: false,
      canOpenFile: false,
      canPreviewInline: true,
      canRenderClientSide: status === "ready",
    },
  };
}
