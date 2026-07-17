import { randomUUID } from "node:crypto";
import { tool, type ToolRuntime } from "langchain";
import type { VideoPresentationCreateRequest } from "@sourceweft/contracts/video-presentation";
import { GENERATE_VIDEO_PRESENTATION_TOOL_NAME } from "./agent-tool-defs";
import {
  buildArtifactPreviewUrl,
  buildSourceJsonArtifactUrl,
} from "./artifact-urls";
import { buildVideoPresentationInitialPayload } from "./video-presentation-payload";
import { buildVideoPresentationRequestKey } from "./video-presentation-request";
import {
  buildVideoPresentationInputRequiredResult,
  buildVideoPresentationProcessingResult,
  buildVideoPresentationToolResult,
} from "./video-presentation-result";
import {
  buildVideoPresentationProjectFileName,
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
  findStatus(input: {
    teamId: string;
    workspaceId: string;
    artifactId: string;
  }): Promise<{
    id: string;
    status: string;
    title: string;
    payloadJson?: unknown;
    errorMessage?: string | null;
  } | null>;
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
    request: VideoPresentationCreateRequest;
    narrationEnabled: boolean;
    traceId?: string;
    parentSpanId?: string;
    toolCallId?: string;
    llm?: VideoPresentationToolLlmExecutionConfig;
  }): Promise<void>;
}

export type VideoPresentationToolLlmExecutionConfig = {
  profileAlias?: string;
  modelAlias?: string;
  providerModel?: string;
  executionMode?: "GLOBAL" | "BYOK";
  providerHint?: string;
  byokModelId?: string;
  credentialId?: string;
  byok?: {
    provider: string;
    providerKind?: string;
    baseUrl?: string;
    apiKey?: string;
    apiKeyRef?: string;
    defaultHeaders?: Record<string, string>;
  };
  thinking?: {
    mode?: "auto" | "off" | "effort";
    enabled?: boolean;
    effort?: "minimal" | "low" | "medium" | "high" | "xhigh";
    includeReasoning?: boolean;
    supportedParameters?: string[];
    supportedEfforts?: Array<"minimal" | "low" | "medium" | "high" | "xhigh">;
  };
};

export interface VideoPresentationToolRuntimeDeps {
  artifacts: VideoPresentationToolArtifacts;
  queue: VideoPresentationToolQueue;
  wait?: {
    intervalMs?: number;
    timeoutMs?: number;
  };
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
  defaultRequest?: Partial<GenerateVideoPresentationArgs>;
  llm?: VideoPresentationToolLlmExecutionConfig;
}

// ── Runtime prompt ──────────────────────────────────────────────────────────

export function buildVideoPresentationRuntimePromptLines(input: {
  videoSelection:
    | { mode?: unknown; narration?: { enabled?: boolean } }
    | undefined;
}): string[] {
  return buildPackageVideoPresentationRuntimePromptLines({
    toolName: GENERATE_VIDEO_PRESENTATION_TOOL_NAME,
    videoSelection: input.videoSelection as
      | { narration?: { enabled?: boolean } }
      | undefined,
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

function readPayloadGeneration(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const generation = (payload as Record<string, unknown>).generation;
  if (
    !generation ||
    typeof generation !== "object" ||
    Array.isArray(generation)
  ) {
    return null;
  }
  return generation as Record<string, unknown>;
}

function readPayloadGenerationStatus(
  payload: unknown,
): "pending" | "running" | "ready" | "failed" | undefined {
  const generation = readPayloadGeneration(payload);
  if (!generation) {
    return undefined;
  }
  const status = generation.status;
  return status === "pending" ||
    status === "running" ||
    status === "ready" ||
    status === "failed"
    ? status
    : undefined;
}

function readPayloadGenerationStage(payload: unknown): string | undefined {
  const stage = readPayloadGeneration(payload)?.stage;
  return typeof stage === "string" && stage.length > 0 ? stage : undefined;
}

function readPayloadGenerationNumber(
  payload: unknown,
  key: "attempt" | "maxAttempts" | "progress",
): number | undefined {
  const value = readPayloadGeneration(payload)?.[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function readPayloadGenerationRetrying(payload: unknown): boolean | undefined {
  const value = readPayloadGeneration(payload)?.retrying;
  return typeof value === "boolean" ? value : undefined;
}

function readPayloadGenerationError(payload: unknown): string | undefined {
  const errorMessage = readPayloadGeneration(payload)?.errorMessage;
  return typeof errorMessage === "string" && errorMessage.length > 0
    ? errorMessage
    : undefined;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type VideoPresentationArtifactSnapshot = {
  id: string;
  status: string;
  title: string;
  payloadJson?: unknown;
  errorMessage?: string | null;
};

function trimString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function deriveTitleFromBrief(brief: string) {
  const firstLine = brief
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
  const title = (firstLine ?? "Video Presentation")
    .replace(/^生成\s*/u, "")
    .replace(/^create\s+/iu, "")
    .replace(/\s+/g, " ")
    .slice(0, 120)
    .trim();
  return title || "Video Presentation";
}

function normalizeVideoPresentationRequest(
  input: GenerateVideoPresentationArgs,
  defaultNarration?: { enabled?: boolean },
) {
  const sourceDigest = trimString(input.sourceDigest);
  const brief = trimString(input.brief) || sourceDigest;
  const title = trimString(input.title) || deriveTitleFromBrief(brief);
  const renderProfile = {
    stylePreset:
      input.renderProfile?.stylePreset ?? input.stylePreset ?? "cinematic",
    visualDensity: input.renderProfile?.visualDensity ?? "balanced",
    durationTarget:
      input.renderProfile?.durationTarget ?? input.durationTarget ?? "medium",
    language: input.renderProfile?.language ?? input.language ?? "auto",
  } satisfies NonNullable<GenerateVideoPresentationArgs["renderProfile"]> & {
    stylePreset: NonNullable<GenerateVideoPresentationArgs["stylePreset"]>;
    visualDensity: "light" | "balanced" | "dense";
    durationTarget: NonNullable<
      GenerateVideoPresentationArgs["durationTarget"]
    >;
    language: string;
  };
  const narrationEnabled =
    input.narration?.enabled ??
    input.narrationEnabled ??
    defaultNarration?.enabled ??
    true;

  return {
    ...input,
    brief,
    title,
    sourceDigest: sourceDigest || brief,
    renderProfile,
    narration: { enabled: narrationEnabled },
  } satisfies GenerateVideoPresentationArgs;
}

function mergeRawVideoPresentationArgsWithDefaults(
  rawArgs: GenerateVideoPresentationArgs,
  defaultRequest?: Partial<GenerateVideoPresentationArgs>,
) {
  if (!defaultRequest) {
    return rawArgs;
  }
  const renderProfile = {
    ...(defaultRequest.renderProfile ?? {}),
    ...(rawArgs.renderProfile ?? {}),
  };
  const brand = {
    ...(defaultRequest.brand ?? {}),
    ...(rawArgs.brand ?? {}),
  };
  const motion = {
    ...(defaultRequest.motion ?? {}),
    ...(rawArgs.motion ?? {}),
  };
  const canvas = {
    ...(defaultRequest.canvas ?? {}),
    ...(rawArgs.canvas ?? {}),
  };
  const narration = {
    ...(defaultRequest.narration ?? {}),
    ...(rawArgs.narration ?? {}),
  };
  return {
    ...defaultRequest,
    ...rawArgs,
    ...(Object.keys(renderProfile).length > 0 ? { renderProfile } : {}),
    ...(Object.keys(brand).length > 0 ? { brand } : {}),
    ...(Object.keys(motion).length > 0 ? { motion } : {}),
    ...(Object.keys(canvas).length > 0 ? { canvas } : {}),
    ...(Object.keys(narration).length > 0 ? { narration } : {}),
  };
}

function resolveArtifactGenerationStatus(
  artifact: VideoPresentationArtifactSnapshot,
): "pending" | "running" | "ready" | "failed" {
  if (artifact.status === "ready") {
    return "ready";
  }
  if (artifact.status === "failed") {
    return "failed";
  }
  return readPayloadGenerationStatus(artifact.payloadJson) ?? "pending";
}

function buildVideoPresentationFailureMessage(
  artifact: VideoPresentationArtifactSnapshot,
) {
  return (
    readPayloadGenerationError(artifact.payloadJson) ??
    (typeof artifact.errorMessage === "string" &&
    artifact.errorMessage.length > 0
      ? artifact.errorMessage
      : "Video presentation project generation failed.")
  );
}

// ── Tool factory ────────────────────────────────────────────────────────────

const VIDEO_PRESENTATION_RENDER_JOB = "video_presentation_render";
const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_WAIT_INTERVAL_MS = 2_000;

export function createGenerateVideoPresentationTool(
  ctx: VideoPresentationToolContext,
  deps: VideoPresentationToolRuntimeDeps,
) {
  return tool(
    async (rawArgs: GenerateVideoPresentationArgs, runtime: ToolRuntime) => {
      const parsedArgs = parseGenerateVideoPresentationArgs(
        mergeRawVideoPresentationArgsWithDefaults(rawArgs, ctx.defaultRequest),
      );
      const toolCallId = resolveToolRuntimeCallId(runtime);
      const args = normalizeVideoPresentationRequest(
        parsedArgs,
        ctx.defaultNarration,
      );
      if (!args.brief.trim()) {
        return buildVideoPresentationInputRequiredResult({
          message:
            "A short brief is required, for example: generate a video presentation explaining the Feynman learning method.",
        });
      }
      const title = args.title ?? "Video Presentation";
      const narrationEnabled = args.narration?.enabled ?? true;
      const requestKey = buildVideoPresentationRequestKey({
        workspaceId: ctx.workspaceId,
        threadId: ctx.threadId,
        userMessageId: ctx.sourceUserMessageId ?? ctx.userMessageId,
        modelIdentifier:
          ctx.llm?.executionMode === "BYOK"
            ? ctx.llm.byokModelId ?? ctx.llm.credentialId
            : ctx.llm?.modelAlias ?? ctx.llm?.profileAlias,
        requestFingerprint: {
          brief: args.brief,
          renderProfile: args.renderProfile,
          narrationEnabled,
          canvas: args.canvas,
          brand: args.brand,
          motion: args.motion,
        },
      });
      const reusableArtifact = await deps.artifacts.findReusable({
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
      const sourceJsonUrl = buildSourceJsonArtifactUrl({
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
          source_json_url: sourceJsonUrl,
          file_name: metadataFileName,
          job_id: queueJobId,
          narration_enabled: narrationEnabled,
          request_key: requestKey,
          render_strategy: "frontend_remotion_project_to_video",
          progress: 0,
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
        request: args,
        narrationEnabled,
        traceId: ctx.traceId,
        parentSpanId: ctx.parentSpanId,
        toolCallId,
        ...(ctx.llm ? { llm: ctx.llm } : {}),
      };

      const waitForArtifactReady = async () => {
        const timeoutMs = Math.max(
          1_000,
          deps.wait?.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS,
        );
        const intervalMs = Math.max(
          250,
          deps.wait?.intervalMs ?? DEFAULT_WAIT_INTERVAL_MS,
        );
        const startedAt = Date.now();
        let lastProgressFingerprint: string | undefined;
        let lastStage: string | undefined;
        while (Date.now() - startedAt <= timeoutMs) {
          const artifact = await deps.artifacts.findStatus({
            teamId: ctx.teamId,
            workspaceId: ctx.workspaceId,
            artifactId,
          });
          if (artifact) {
            const status = resolveArtifactGenerationStatus(artifact);
            const stage = readPayloadGenerationStage(artifact.payloadJson);
            const progress = readPayloadGenerationNumber(
              artifact.payloadJson,
              "progress",
            );
            const attempt = readPayloadGenerationNumber(
              artifact.payloadJson,
              "attempt",
            );
            const maxAttempts = readPayloadGenerationNumber(
              artifact.payloadJson,
              "maxAttempts",
            );
            const retrying = readPayloadGenerationRetrying(
              artifact.payloadJson,
            );
            const progressFingerprint = JSON.stringify({
              attempt,
              maxAttempts,
              progress,
              retrying,
              stage,
              status,
            });
            if (progressFingerprint !== lastProgressFingerprint) {
              lastProgressFingerprint = progressFingerprint;
              lastStage = stage;
              emitProgress({
                ...(typeof attempt === "number" ? { attempt } : {}),
                ...(typeof maxAttempts === "number"
                  ? { max_attempts: maxAttempts }
                  : {}),
                ...(typeof progress === "number" ? { progress } : {}),
                ...(typeof retrying === "boolean" ? { retrying } : {}),
                status,
                stage,
                title: artifact.title || title,
              });
            }
            if (status === "ready") {
              return { artifact, status, stage } as const;
            }
            if (status === "failed") {
              return { artifact, status, stage } as const;
            }
          }
          await sleep(intervalMs);
        }
        return {
          artifact: await deps.artifacts.findStatus({
            teamId: ctx.teamId,
            workspaceId: ctx.workspaceId,
            artifactId,
          }),
          status: "timeout" as const,
          stage: lastStage,
        };
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
        if (existingStatus !== "ready") {
          const waitResult = await waitForArtifactReady();
          if (waitResult.status === "ready" && waitResult.artifact) {
            const readyPayload = waitResult.artifact.payloadJson;
            const readyFileName =
              readStringPayloadValue(readyPayload, "fileName") ??
              existingFileName;
            emitProgress({
              reused: true,
              status: "ready",
              stage: "ready",
              title: waitResult.artifact.title || title,
            });
            return buildVideoPresentationToolResult({
              artifactId,
              artifactUrl:
                readStringPayloadValue(readyPayload, "artifactUrl") ??
                artifactUrl,
              fileName: readyFileName,
              jobId:
                readStringPayloadValue(readyPayload, "jobId") ?? queueJobId,
              narrationEnabled,
              reused: true,
              sourceJsonUrl:
                readStringPayloadValue(readyPayload, "sourceJsonUrl") ??
                sourceJsonUrl,
              status: "ready",
              title: waitResult.artifact.title || title,
              versionId: readStringPayloadValue(readyPayload, "versionId"),
            });
          }
          if (waitResult.status === "failed" && waitResult.artifact) {
            const failedPayload = waitResult.artifact.payloadJson;
            const failureMessage = buildVideoPresentationFailureMessage(
              waitResult.artifact,
            );
            emitProgress({
              reused: true,
              status: "failed",
              stage: "failed",
              title: waitResult.artifact.title || title,
            });
            return buildVideoPresentationToolResult({
              artifactId,
              artifactUrl:
                readStringPayloadValue(failedPayload, "artifactUrl") ??
                artifactUrl,
              errorMessage: failureMessage,
              fileName:
                readStringPayloadValue(failedPayload, "fileName") ??
                existingFileName,
              jobId:
                readStringPayloadValue(failedPayload, "jobId") ?? queueJobId,
              narrationEnabled,
              reused: true,
              sourceJsonUrl:
                readStringPayloadValue(failedPayload, "sourceJsonUrl") ??
                sourceJsonUrl,
              status: "failed",
              title: waitResult.artifact.title || title,
            });
          }
          return buildVideoPresentationProcessingResult({
            artifactId,
            artifactUrl,
            fileName: existingFileName,
            jobId: queueJobId,
            narrationEnabled,
            sourceJsonUrl,
            stage: waitResult.stage,
            title: reusableArtifact.title || title,
          });
        }
        return buildVideoPresentationToolResult({
          artifactId,
          artifactUrl:
            readStringPayloadValue(payload, "artifactUrl") ?? artifactUrl,
          fileName: existingFileName,
          jobId: readStringPayloadValue(payload, "jobId") ?? queueJobId,
          narrationEnabled,
          reused: true,
          sourceJsonUrl:
            readStringPayloadValue(payload, "sourceJsonUrl") ?? sourceJsonUrl,
          status: existingStatus,
          title: reusableArtifact.title || title,
        });
      }

      const payload = buildVideoPresentationInitialPayload({
        artifactId,
        fileName,
        jobId: queueJobId,
        request: args,
        requestKey,
        workspaceId: ctx.workspaceId,
      });

      await deps.artifacts.createPending({
        artifactId,
        teamId: ctx.teamId,
        workspaceId: ctx.workspaceId,
        threadId: ctx.threadId,
        userId: ctx.userId,
        title,
        prompt: payload.prompt,
        payload,
      });

      await deps.queue.enqueueRender(enqueuePayload);
      emitProgress();

      const waitResult = await waitForArtifactReady();
      if (waitResult.status === "ready" && waitResult.artifact) {
        const readyPayload = waitResult.artifact.payloadJson;
        const readyFileName =
          readStringPayloadValue(readyPayload, "fileName") ?? fileName;
        emitProgress({
          status: "ready",
          stage: "ready",
          title: waitResult.artifact.title || title,
        });
        return buildVideoPresentationToolResult({
          artifactId,
          artifactUrl:
            readStringPayloadValue(readyPayload, "artifactUrl") ?? artifactUrl,
          fileName: readyFileName,
          jobId: readStringPayloadValue(readyPayload, "jobId") ?? queueJobId,
          narrationEnabled,
          sourceJsonUrl:
            readStringPayloadValue(readyPayload, "sourceJsonUrl") ??
            sourceJsonUrl,
          status: "ready",
          title: waitResult.artifact.title || title,
          versionId: readStringPayloadValue(readyPayload, "versionId"),
        });
      }
      if (waitResult.status === "failed" && waitResult.artifact) {
        const failedPayload = waitResult.artifact.payloadJson;
        const failureMessage = buildVideoPresentationFailureMessage(
          waitResult.artifact,
        );
        emitProgress({
          status: "failed",
          stage: "failed",
          title: waitResult.artifact.title || title,
        });
        return buildVideoPresentationToolResult({
          artifactId,
          artifactUrl:
            readStringPayloadValue(failedPayload, "artifactUrl") ?? artifactUrl,
          errorMessage: failureMessage,
          fileName:
            readStringPayloadValue(failedPayload, "fileName") ?? fileName,
          jobId: readStringPayloadValue(failedPayload, "jobId") ?? queueJobId,
          narrationEnabled,
          sourceJsonUrl:
            readStringPayloadValue(failedPayload, "sourceJsonUrl") ??
            sourceJsonUrl,
          status: "failed",
          title: waitResult.artifact.title || title,
        });
      }

      return buildVideoPresentationProcessingResult({
        artifactId,
        artifactUrl,
        fileName,
        jobId: queueJobId,
        narrationEnabled,
        sourceJsonUrl,
        stage: waitResult.stage,
        title,
      });
    },
    {
      name: GENERATE_VIDEO_PRESENTATION_TOOL_NAME,
      description:
        "Generate one narrated video presentation artifact from a short brief. Provide brief plus optional title, sourceDigest, audience, tone, language, durationTarget, stylePreset, renderProfile, narrationEnabled, narration, assets, and regeneration. Do not provide a storyboard or blueprint; the worker builds the Remotion project internally and waits for the ready artifact.",
      returnDirect: true,
      schema: generateVideoPresentationSchema,
    },
  );
}

export function looksLikeVideoPresentationSpecText(value: string) {
  const record = parseJsonObjectText(value);
  if (!record || record.schemaVersion !== 2) {
    return false;
  }
  return (
    record.kind === "video_presentation" &&
    typeof record.project === "object" &&
    Array.isArray(record.slides) &&
    Array.isArray(record.sceneModules) &&
    typeof record.generation === "object"
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
