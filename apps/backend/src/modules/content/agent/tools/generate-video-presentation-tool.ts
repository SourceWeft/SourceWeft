import { randomUUID } from "node:crypto";
import { tool, type ToolRuntime } from "langchain";
import { z } from "zod";
import {
  createPendingVideoPresentationArtifactRecord,
  findReusableVideoPresentationArtifactRecord,
} from "../../artifacts/repository";
import {
  enqueueVideoPresentationRenderJob,
  VIDEO_PRESENTATION_RENDER_JOB,
} from "../../queue";
import {
  buildVideoPresentationProjectFileName,
  compactVideoPresentationSourceText,
  sanitizeVideoPresentationFileBase,
} from "../../video-presentation/spec";
import { AGENT_TOOL_NAMES } from "../tool-names";
import type { GenerateVideoPresentationToolSelection } from "../../artifacts/types";
import type { RuntimePromptContext } from "../prompts/tool-prompt-provider";
import { toObjectRecord } from "../turn/content";

export const GENERATED_VIDEO_PRESENTATION_PROGRESS_EVENT_TYPE =
  "generate_video_presentation_progress";

export function buildVideoPresentationRuntimePromptLines(input: {
  videoSelection: GenerateVideoPresentationToolSelection | undefined;
}): string[] {
  const { videoSelection } = input;
  return [
    `${AGENT_TOOL_NAMES.generateVideoPresentation} is available for narrated video presentation artifacts. Use it when the user asks to create a video presentation, narrated deck, or slides-to-video deliverable.`,
    "This tool creates a trusted Remotion video project with structured scenes and narration audio; the browser previews the project and renders the final video only when the user downloads it. Do not describe this as server-side MP4 rendering, background video rendering, or a completed MP4.",
    "Before calling generate_video_presentation, gather the factual source content, choose a concise video title, and pass any requested audience, tone, pacing, or visual style as user_prompt. Do not expose PPTX style presets or deck configuration.",
    "The video renderer uses trusted Remotion scene components from structured project data; never provide raw TSX or executable code.",
    "Use source_content for the factual material to present. Use user_prompt for natural-language style direction such as technical, executive, cinematic, energetic, or calm.",
    "Never write the internal video schema, schemaVersion JSON, slides array, scenes array, narrationEnabled object, or planner output in the chat. The user should only see the generated artifact card and a short status.",
    `Narration defaults to ${videoSelection?.narration?.enabled === false ? "off" : "on"}.`,
    `Never claim a video presentation artifact was created unless ${AGENT_TOOL_NAMES.generateVideoPresentation} completed successfully.`,
    `After ${AGENT_TOOL_NAMES.generateVideoPresentation} succeeds, say the video presentation project has been created and is preparing assets if status is pending or running. Say it is ready only if the tool result status is ready. Do not say "the video has been generated" or imply the final video/MP4 has already been rendered. Do not include raw artifact IDs, raw artifact URLs, source JSON, or tool schemas.`,
  ];
}

export const videoPresentationRuntimePromptProvider: import("../prompts/tool-prompt-provider").ArtifactToolRuntimePromptProvider = {
  buildLines(context: RuntimePromptContext) {
    if (!context.availableArtifactTools.includes(AGENT_TOOL_NAMES.generateVideoPresentation)) {
      return [];
    }
    return buildVideoPresentationRuntimePromptLines({ videoSelection: context.generateVideoPresentationTool });
  },
};

const generateVideoPresentationSchema = z
  .object({
    source_content: z.string().min(1).max(50_000),
    video_title: z.string().max(160).optional(),
    user_prompt: z.string().max(2000).optional(),
    narration: z
      .object({
        enabled: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

type GenerateVideoPresentationArgs = z.infer<
  typeof generateVideoPresentationSchema
>;

function parseGenerateVideoPresentationArgs(input: unknown) {
  const parsed = generateVideoPresentationSchema.parse(input);
  const sourceContent = parsed.source_content.trim();
  if (!sourceContent) {
    throw new z.ZodError([
      {
        code: "custom",
        path: ["source_content"],
        message: "source_content is required.",
      },
    ]);
  }
  const videoTitle = parsed.video_title?.trim();
  const userPrompt = parsed.user_prompt?.trim();
  return {
    ...parsed,
    source_content: sourceContent,
    ...(videoTitle ? { video_title: videoTitle } : {}),
    ...(userPrompt ? { user_prompt: userPrompt } : {}),
  };
}

function buildArtifactPreviewUrl(input: {
  artifactId: string;
  workspaceId: string;
}) {
  const params = new URLSearchParams({
    artifactId: input.artifactId,
    workspaceId: input.workspaceId,
  });
  return `/artifact-preview?${params.toString()}`;
}

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

function buildInitialPayload(input: {
  artifactId: string;
  fileName: string;
  jobId: string;
  narrationEnabled: boolean;
  requestKey: string;
  sourceContent: string;
  title: string;
  userPrompt?: string;
  workspaceId: string;
}) {
  return {
    title: input.title,
    prompt: input.userPrompt ?? compactVideoPresentationSourceText(input.sourceContent),
    artifactKind: "video_presentation",
    renderStrategy: "frontend_remotion_project_to_video",
    videoDownloadOnly: true,
    mimeType: "application/vnd.sourceweft.video-presentation+json",
    fileName: input.fileName,
    jobId: input.jobId,
    requestKey: input.requestKey,
    generation: {
      status: "pending",
      stage: "planning",
    },
    narrationEnabled: input.narrationEnabled,
    source: {
      contentPreview: compactVideoPresentationSourceText(
        input.sourceContent,
        1200,
      ),
      userPrompt: input.userPrompt,
    },
    artifactUrl: buildArtifactPreviewUrl({
      workspaceId: input.workspaceId,
      artifactId: input.artifactId,
    }),
  };
}

function buildToolResult(input: {
  artifactId: string;
  artifactUrl: string;
  durationSeconds?: number;
  fileName: string;
  jobId?: string;
  narrationEnabled: boolean;
  reused?: boolean;
  status?: "pending" | "running" | "ready";
  title: string;
  versionId?: string;
}) {
  const status = input.status ?? "pending";
  return {
    type: "video_presentation_artifact_result",
    artifact_id: input.artifactId,
    artifact_url: input.artifactUrl,
    content:
      status === "ready"
        ? `Video presentation project ready: ${input.fileName}\nThe application can preview it and export the final video in the browser.`
        : `Video presentation project queued: ${input.fileName}\nThe application is preparing the scene spec and narration assets in the background.`,
    ...(typeof input.durationSeconds === "number"
      ? { duration_seconds: input.durationSeconds }
      : {}),
    file_name: input.fileName,
    ...(input.jobId ? { job_id: input.jobId } : {}),
    narration_enabled: input.narrationEnabled,
    render_strategy: "frontend_remotion_project_to_video",
    ...(input.reused ? { reused: true } : {}),
    status,
    title: input.title,
    ...(input.versionId ? { version_id: input.versionId } : {}),
    video_download_only: true,
  };
}

function buildVideoPresentationRequestKey(input: {
  threadId: string;
  userMessageId: string;
  workspaceId: string;
}) {
  return [
    "video_presentation",
    input.workspaceId,
    input.threadId,
    input.userMessageId,
  ].join(":");
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

export function createGenerateVideoPresentationTool(input: {
  defaultNarration?: GenerateVideoPresentationArgs["narration"];
  teamId: string;
  workspaceId: string;
  threadId: string;
  userId: string;
  userMessageId: string;
  sourceUserMessageId?: string;
  traceId?: string;
  parentSpanId?: string;
}) {
  return tool(
    async (rawArgs: GenerateVideoPresentationArgs, runtime: ToolRuntime) => {
      const args = parseGenerateVideoPresentationArgs(rawArgs);
      const toolCallId = resolveToolRuntimeCallId(runtime);
      const title = args.video_title?.trim() || "Video Presentation";
      const narrationEnabled =
        args.narration?.enabled ?? input.defaultNarration?.enabled ?? true;
      const requestKey = buildVideoPresentationRequestKey({
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        userMessageId: input.sourceUserMessageId ?? input.userMessageId,
      });
      const reusableArtifact = await findReusableVideoPresentationArtifactRecord({
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        requestKey,
      });
      const artifactId = reusableArtifact?.id ?? randomUUID();
      const queueJobId = `${VIDEO_PRESENTATION_RENDER_JOB}_${artifactId}`;
      const fileName = buildVideoPresentationProjectFileName(title);
      const artifactUrl = buildArtifactPreviewUrl({
        workspaceId: input.workspaceId,
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
          tool: AGENT_TOOL_NAMES.generateVideoPresentation,
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
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        userId: input.userId,
        userMessageId: input.userMessageId,
        title,
        sourceContent: args.source_content,
        userPrompt: args.user_prompt,
        narrationEnabled,
        traceId: input.traceId,
        parentSpanId: input.parentSpanId,
        toolCallId,
      };

      if (reusableArtifact) {
        const payload = reusableArtifact.payloadJson;
        const existingStatus =
          reusableArtifact.status === "ready"
            ? "ready"
            : (readPayloadGenerationStatus(payload) ?? "pending");
        if (existingStatus !== "ready") {
          await enqueueVideoPresentationRenderJob(enqueuePayload);
        }
        const existingFileName =
          readStringPayloadValue(payload, "fileName") ?? fileName;
        emitProgress({ reused: true, status: existingStatus });
        return buildToolResult({
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

      const payload = buildInitialPayload({
        artifactId,
        fileName,
        jobId: queueJobId,
        narrationEnabled,
        requestKey,
        sourceContent: args.source_content,
        title,
        userPrompt: args.user_prompt,
        workspaceId: input.workspaceId,
      });

      await createPendingVideoPresentationArtifactRecord({
        artifactId,
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        userId: input.userId,
        title,
        prompt:
          args.user_prompt ??
          compactVideoPresentationSourceText(args.source_content),
        payload,
      });

      await enqueueVideoPresentationRenderJob(enqueuePayload);
      emitProgress();

      return buildToolResult({
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
      name: AGENT_TOOL_NAMES.generateVideoPresentation,
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
    return toObjectRecord(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

export const testExports = {
  buildArtifactPreviewUrl,
  buildVideoPresentationRequestKey,
  buildInitialPayload,
  buildToolResult,
  generateVideoPresentationSchema,
  parseGenerateVideoPresentationArgs,
  sanitizeVideoPresentationFileBase,
};
