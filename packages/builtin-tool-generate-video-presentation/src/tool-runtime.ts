import { randomUUID } from "node:crypto";
import { tool, type ToolRuntime } from "langchain";
import { GENERATE_VIDEO_PRESENTATION_TOOL_NAME } from "./agent-tool-defs";
import { buildArtifactPreviewUrl } from "./artifact-urls";
import { buildVideoPresentationInitialPayload } from "./video-presentation-payload";
import { buildVideoPresentationRequestKey } from "./video-presentation-request";
import { buildVideoPresentationToolResult } from "./video-presentation-result";
import {
  buildVideoPresentationProjectFileName,
  compactVideoPresentationSourceText,
  sanitizeVideoPresentationFileBase,
} from "./video-presentation-files";
import {
  generateVideoPresentationSchema,
  parseGenerateVideoPresentationArgs,
  type GenerateVideoPresentationArgs,
} from "./video-presentation-schema";
import { buildVideoPresentationRuntimePromptLines as buildPackageVideoPresentationRuntimePromptLines } from "./video-presentation-prompts";

export const GENERATED_VIDEO_PRESENTATION_PROGRESS_EVENT_TYPE =
  "generate_video_presentation_progress";

// ── Backend dependency interfaces ───────────────────────────────────────────

export interface VideoPresentationToolArtifacts {
  findReusable(input: {
    teamId: string;
    workspaceId: string;
    threadId: string;
    requestKey: string;
  }): Promise<{
    id: string;
    status: string;
    title: string;
    payloadJson?: unknown;
  } | null>;
  createPending(input: {
    artifactId: string;
    teamId: string;
    workspaceId: string;
    threadId: string;
    userId: string;
    title: string;
    prompt: string;
    payload: unknown;
  }): Promise<void>;
}

export interface VideoPresentationToolQueue {
  enqueueRender(input: {
    artifactId: string;
    jobId: string;
    requestKey: string;
    teamId: string;
    workspaceId: string;
    threadId: string;
    userId: string;
    userMessageId: string;
    title: string;
    sourceContent: unknown;
    userPrompt?: string;
    narrationEnabled: boolean;
    traceId?: string;
    parentSpanId?: string;
    toolCallId?: string;
  }): Promise<void>;
}

export interface VideoPresentationToolRuntimeDeps {
  artifacts: VideoPresentationToolArtifacts;
  queue: VideoPresentationToolQueue;
}

export interface VideoPresentationToolContext {
  teamId: string;
  workspaceId: string;
  threadId: string;
  userId: string;
  userMessageId: string;
  sourceUserMessageId?: string;
  traceId?: string;
  parentSpanId?: string;
  defaultNarration?: { enabled?: boolean };
}

// ── Runtime prompt ──────────────────────────────────────────────────────────

export function buildVideoPresentationRuntimePromptLines(input: {
  videoSelection: { mode?: unknown; narration?: { enabled?: boolean } } | undefined;
}): string[] {
  return buildPackageVideoPresentationRuntimePromptLines({
    toolName: GENERATE_VIDEO_PRESENTATION_TOOL_NAME,
    videoSelection: input.videoSelection as { narration?: { enabled?: boolean } } | undefined,
  });
}

export const videoPresentationRuntimePromptProvider = {
  buildLines(context: {
    availableArtifactTools: string[];
    runtimeTools?: Readonly<
      Record<string, { options?: unknown; selection?: unknown }>
    >;
  }) {
    if (
      !context.availableArtifactTools.includes(
        GENERATE_VIDEO_PRESENTATION_TOOL_NAME,
      )
    ) {
      return [];
    }
    const runtimeTool =
      context.runtimeTools?.[GENERATE_VIDEO_PRESENTATION_TOOL_NAME];
    const videoSelection = runtimeTool?.options ?? runtimeTool?.selection;
    return buildVideoPresentationRuntimePromptLines({
      videoSelection: videoSelection as
        | { mode?: unknown; narration?: { enabled?: boolean } }
        | undefined,
    });
  },
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function resolveToolRuntimeCallId(runtime: ToolRuntime) {
  const runtimeRecord = runtime as ToolRuntime & {
    config?: { toolCall?: { id?: unknown } };
    toolCall?: { id?: unknown };
    toolCallId?: unknown;
  };
  const candidate =
    runtimeRecord.toolCallId ??
    runtimeRecord.toolCall?.id ??
    runtimeRecord.config?.toolCall?.id;
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : undefined;
}

function readStringPayloadValue(
  payload: unknown,
  key: string,
): string | undefined {
  return payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    typeof (payload as Record<string, unknown>)[key] === "string"
    ? ((payload as Record<string, unknown>)[key] as string)
    : undefined;
}

function readPayloadGenerationStatus(
  payload: unknown,
): "pending" | "running" | "ready" | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const generation = (payload as Record<string, unknown>).generation;
  if (
    !generation ||
    typeof generation !== "object" ||
    Array.isArray(generation)
  ) {
    return undefined;
  }
  const status = (generation as Record<string, unknown>).status;
  return status === "pending" || status === "running" || status === "ready"
    ? status
    : undefined;
}

// ── Tool factory ────────────────────────────────────────────────────────────

const VIDEO_PRESENTATION_RENDER_JOB = "video_presentation_render";

export function createGenerateVideoPresentationTool(
  ctx: VideoPresentationToolContext,
  deps: VideoPresentationToolRuntimeDeps,
) {
  return tool(
    async (rawArgs: GenerateVideoPresentationArgs, runtime: ToolRuntime) => {
      const args = parseGenerateVideoPresentationArgs(rawArgs);
      const toolCallId = resolveToolRuntimeCallId(runtime);
      const title = args.video_title?.trim() || "Video Presentation";
      const narrationEnabled =
        args.narration?.enabled ?? ctx.defaultNarration?.enabled ?? true;
      const requestKey = buildVideoPresentationRequestKey({
        workspaceId: ctx.workspaceId,
        threadId: ctx.threadId,
        userMessageId: ctx.sourceUserMessageId ?? ctx.userMessageId,
      });
      const reusableArtifact =
        await deps.artifacts.findReusable({
          teamId: ctx.teamId,
          workspaceId: ctx.workspaceId,
          threadId: ctx.threadId,
          requestKey,
        });
      const artifactId = reusableArtifact?.id ?? randomUUID();
      const queueJobId = `${VIDEO_PRESENTATION_RENDER_JOB}_${artifactId}`;
      const fileName = buildVideoPresentationProjectFileName(title);
      const artifactUrl = buildArtifactPreviewUrl({
        workspaceId: ctx.workspaceId,
        artifactId,
      });
      const emitProgress = (metadata?: Record<string, unknown>) => {
        if (!toolCallId) {
          return;
        }
        const metadataFileName =
          typeof metadata?.fileName === "string" ? metadata.fileName : fileName;
        runtime.writer?.({
          type: GENERATED_VIDEO_PRESENTATION_PROGRESS_EVENT_TYPE,
          toolCallId,
          tool: GENERATE_VIDEO_PRESENTATION_TOOL_NAME,
          artifact_id: artifactId,
          artifact_url: artifactUrl,
          file_name: metadataFileName,
          job_id: queueJobId,
          narration_enabled: narrationEnabled,
          request_key: requestKey,
          render_strategy: "frontend_remotion_project_to_video",
          status: "pending",
          stage: "planning",
          title,
          video_download_only: true,
          ...metadata,
        });
      };

      const enqueuePayload = {
        artifactId,
        jobId: queueJobId,
        requestKey,
        teamId: ctx.teamId,
        workspaceId: ctx.workspaceId,
        threadId: ctx.threadId,
        userId: ctx.userId,
        userMessageId: ctx.userMessageId,
        title,
        sourceContent: args.source_content,
        userPrompt: args.user_prompt,
        narrationEnabled,
        traceId: ctx.traceId,
        parentSpanId: ctx.parentSpanId,
        toolCallId,
      };

      if (reusableArtifact) {
        const payload = reusableArtifact.payloadJson;
        const existingStatus =
          reusableArtifact.status === "ready"
            ? "ready"
            : (readPayloadGenerationStatus(payload) ?? "pending");
        if (existingStatus !== "ready") {
          await deps.queue.enqueueRender(enqueuePayload);
        }
        const existingFileName =
          readStringPayloadValue(payload, "fileName") ?? fileName;
        emitProgress({ reused: true, status: existingStatus });
        return buildVideoPresentationToolResult({
          artifactId,
          artifactUrl:
            readStringPayloadValue(payload, "artifactUrl") ?? artifactUrl,
          fileName: existingFileName,
          jobId: readStringPayloadValue(payload, "jobId") ?? queueJobId,
          narrationEnabled,
          reused: true,
          status: existingStatus,
          title: reusableArtifact.title || title,
        });
      }

      const payload = buildVideoPresentationInitialPayload({
        artifactId,
        fileName,
        jobId: queueJobId,
        narrationEnabled,
        requestKey,
        sourceContent: args.source_content,
        title,
        userPrompt: args.user_prompt,
        workspaceId: ctx.workspaceId,
      });

      await deps.artifacts.createPending({
        artifactId,
        teamId: ctx.teamId,
        workspaceId: ctx.workspaceId,
        threadId: ctx.threadId,
        userId: ctx.userId,
        title,
        prompt:
          args.user_prompt ??
          compactVideoPresentationSourceText(args.source_content),
        payload,
      });

      await deps.queue.enqueueRender(enqueuePayload);
      emitProgress();

      return buildVideoPresentationToolResult({
        artifactId,
        artifactUrl,
        fileName,
        jobId: queueJobId,
        narrationEnabled,
        status: "pending",
        title,
      });
    },
    {
      name: GENERATE_VIDEO_PRESENTATION_TOOL_NAME,
      description:
        "Generate one narrated video presentation artifact as a trusted Remotion project for browser-side MP4/WebM export. Provide the source material in source_content and optional creative direction in user_prompt. Do not provide raw TSX or HTML; the server maps the request into trusted scene primitives and narration assets in the background, and this tool returns as soon as the project has been queued.",
      schema: generateVideoPresentationSchema,
    },
  );
}

export function looksLikeVideoPresentationSpecText(value: string) {
  const record = parseJsonObjectText(value);
  if (!record || record.schemaVersion !== 1) {
    return false;
  }
  return (
    typeof record.title === "string" &&
    Array.isArray(record.slides) &&
    Array.isArray(record.scenes) &&
    "narrationEnabled" in record
  );
}

function parseJsonObjectText(value: string) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

export const testExports = {
  buildArtifactPreviewUrl,
  buildVideoPresentationRequestKey,
  buildInitialPayload: buildVideoPresentationInitialPayload,
  buildToolResult: buildVideoPresentationToolResult,
  generateVideoPresentationSchema,
  parseGenerateVideoPresentationArgs,
  sanitizeVideoPresentationFileBase,
};
