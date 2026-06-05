import { randomUUID } from "node:crypto";
import { tool, type ToolRuntime } from "langchain";
import { z } from "zod";
import type { ImageGenerateInput } from "@sourceweft/model-gateway";
import { getModelGatewayClient } from "../../../../shared/model-gateway/client";
import type { RuntimeModelGatewayProfile } from "../../../../shared/model-gateway/types";
import type { LlmExecutionConfig } from "../../model-gateway-audit";
import {
  buildArtifactStorageKey,
  getContentStorageBucketName,
  uploadArtifactObject,
} from "../../storage";
import { createImageArtifactRecord } from "../../artifacts/repository";
import type { ArtifactImageConfig } from "../../artifacts/types";
import type { ContentBillingPort } from "../../billing-port";
import { meterBillableModelUsage } from "../../model-billing";
import { AGENT_TOOL_NAMES } from "../tool-names";
import type { RuntimePromptContext } from "../prompts/tool-prompt-provider";

export const GENERATED_IMAGE_PROGRESS_EVENT_TYPE = "generate_image_progress";

export function buildImageRuntimePromptLines(input: {
  config: ArtifactImageConfig;
}): string[] {
  const { config } = input;
  return [
    `Image generation defaults: aspect_ratio=${config.aspectRatio}, quality=${config.quality}, style=${config.style}.`,
    `${AGENT_TOOL_NAMES.generateImage} is available in auto mode. Use it when the user asks you to create a new visual artifact or deliverable; otherwise answer normally.`,
    `For ambiguous requests, decide semantically from the user's goal rather than matching literal keywords. If the user expects a kept visual output, call ${AGENT_TOOL_NAMES.generateImage}.`,
    "If the prompt is missing essential visual details for a requested image, make a reasonable concise prompt instead of asking a separate confirmation.",
    `Never claim an image was created unless ${AGENT_TOOL_NAMES.generateImage} completed successfully.`,
    `After ${AGENT_TOOL_NAMES.generateImage} succeeds, decide whether a short natural-language wrap-up is useful. The application displays the generated image automatically; do not include image markdown or raw artifact URLs.`,
  ];
}

export const imageRuntimePromptProvider: import("../prompts/tool-prompt-provider").ArtifactToolRuntimePromptProvider = {
  buildLines(context: RuntimePromptContext) {
    if (context.artifactIntent?.kind !== "image") {
      return [];
    }
    return buildImageRuntimePromptLines({ config: context.artifactIntent.config });
  },
};

function compactText(value: string, maxLength = 120) {
  const compacted = value.replace(/\s+/g, " ").trim();
  if (compacted.length <= maxLength) {
    return compacted;
  }
  return `${compacted.slice(0, maxLength - 3).trimEnd()}...`;
}

function sanitizeFileName(value: string) {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "generated-image";
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

function buildImageGatewayMetadata(input: {
  traceId?: string;
  parentSpanId?: string;
  profile: RuntimeModelGatewayProfile;
  execution?: LlmExecutionConfig;
  teamId: string;
  workspaceId: string;
  userId: string;
  threadId: string;
  userMessageId: string;
  toolCallId?: string;
}) {
  const isByok = input.execution?.executionMode === "BYOK";
  return {
    traceId: input.traceId,
    parentSpanId: input.parentSpanId,
    ...(isByok ? {} : { profileAlias: input.profile.profileAlias }),
    modelAlias: isByok
      ? input.execution?.modelAlias ??
        input.execution?.providerModel ??
        input.profile.modelAlias
      : input.profile.modelAlias,
    providerModel: input.execution?.providerModel,
    ...(isByok
      ? {
          executionMode: "BYOK",
          byokModelId: input.execution?.byokModelId,
          credentialId: input.execution?.credentialId,
          keySource: "byokCredential",
        }
      : { executionMode: input.execution?.executionMode ?? "GLOBAL" }),
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    userId: input.userId,
    threadId: input.threadId,
    messageId: input.userMessageId,
    toolCallId: input.toolCallId,
    observationName: "image_generation",
    feature: "artifact.image",
    modelKind: "image",
  };
}

async function decodeGeneratedImage(image: {
  b64Json?: string;
  url?: string;
  mimeType?: string;
}) {
  if (image.b64Json) {
    return {
      body: Buffer.from(image.b64Json, "base64"),
      mimeType: image.mimeType ?? "image/png",
    };
  }

  if (!image.url) {
    throw new Error("The image provider did not return image bytes.");
  }

  const response = await fetch(image.url);
  if (!response.ok) {
    throw new Error(`Failed to download generated image: ${response.status}`);
  }
  const contentType = response.headers
    .get("content-type")
    ?.split(";")[0]
    ?.trim();
  return {
    body: Buffer.from(await response.arrayBuffer()),
    mimeType:
      image.mimeType ??
      (contentType && contentType.startsWith("image/")
        ? contentType
        : "image/png"),
  };
}

function formatToolResult(input: {
  artifactId: string;
  versionId: string;
  title: string;
  artifactUrl: string;
  config: ArtifactImageConfig;
  height?: number;
  provider?: string;
  providerModel?: string;
  width?: number;
}) {
  return [
    "Image artifact created.",
    `artifact_id: ${input.artifactId}`,
    `version_id: ${input.versionId}`,
    `title: ${input.title}`,
    `artifact_url: ${input.artifactUrl}`,
    `aspect_ratio: ${input.config.aspectRatio}`,
    typeof input.width === "number" ? `width: ${input.width}` : null,
    typeof input.height === "number" ? `height: ${input.height}` : null,
    `quality: ${input.config.quality}`,
    `style: ${input.config.style}`,
    input.provider ? `provider: ${input.provider}` : null,
    input.providerModel ? `provider_model: ${input.providerModel}` : null,
    "The application will display the generated image automatically. Do not include image markdown or repeat raw URLs.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
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

export function createGenerateImageTool(input: {
  teamId: string;
  workspaceId: string;
  threadId: string;
  userId: string;
  userMessageId: string;
  traceId?: string;
  parentSpanId?: string;
  profile: RuntimeModelGatewayProfile;
  execution?: LlmExecutionConfig;
  config: ArtifactImageConfig;
  billing: ContentBillingPort;
}) {
  return tool(
    async (
      args: {
        prompt: string;
        title?: string;
      },
      runtime: ToolRuntime,
    ) => {
      const prompt = args.prompt.trim();
      const title = (args.title?.trim() || compactText(prompt, 80)).slice(0, 160);
      const toolCallId = resolveToolRuntimeCallId(runtime);
      const emitProgress = (
        stage: "preparing" | "generating" | "saving" | "billing" | "ready",
        metadata?: Record<string, unknown>,
      ) => {
        if (!toolCallId) {
          return;
        }

        runtime.writer?.({
          type: GENERATED_IMAGE_PROGRESS_EVENT_TYPE,
          toolCallId,
          tool: AGENT_TOOL_NAMES.generateImage,
          stage,
          prompt,
          title,
          ...metadata,
        });
      };

      emitProgress("preparing", {
        aspectRatio: input.config.aspectRatio,
        quality: input.config.quality,
        style: input.config.style,
      });
      const gateway = await getModelGatewayClient(input.profile.gatewayConfigId);
      const request: ImageGenerateInput = {
        model:
          input.execution?.executionMode === "BYOK"
            ? input.execution.providerModel ??
              input.execution.modelAlias ??
              input.profile.modelAlias
            : input.profile.profileAlias,
        ...(input.execution ? input.execution : {}),
        prompt,
        aspectRatio: input.config.aspectRatio,
        quality: input.config.quality,
        style: input.config.style,
        count: 1,
        responseFormat: "b64_json",
        metadata: buildImageGatewayMetadata({
          traceId: input.traceId,
          parentSpanId: input.parentSpanId,
          profile: input.profile,
          execution: input.execution,
          teamId: input.teamId,
          workspaceId: input.workspaceId,
          userId: input.userId,
          threadId: input.threadId,
          userMessageId: input.userMessageId,
          toolCallId,
        }),
      };

      emitProgress("generating", {
        providerModel: request.model,
      });
      const result = await gateway.images.generate(request, {
        traceId: input.traceId,
        metadata: {
          parentSpanId: input.parentSpanId,
          toolCallId,
        },
      });
      const image = result.images[0];
      if (!image) {
        throw new Error("Image generation did not return an image.");
      }

      emitProgress("saving", {
        provider: result.provider,
        providerModel: result.providerModel,
      });
      const decoded = await decodeGeneratedImage(image);
      const artifactIdForPath = randomUUID();
      const fileName = `${sanitizeFileName(title)}.png`;
      const storageKey = buildArtifactStorageKey({
        workspaceId: input.workspaceId,
        artifactId: artifactIdForPath,
        fileName,
      });
      await uploadArtifactObject({
        key: storageKey,
        body: decoded.body,
        contentType: decoded.mimeType,
      });

      const bucket = getContentStorageBucketName();
      const { artifactId, versionId } = await createImageArtifactRecord({
        artifactId: artifactIdForPath,
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        userId: input.userId,
        title,
        prompt,
        storageBucket: bucket,
        storageKey,
        payload: {
          prompt,
          title,
          config: input.config,
          mimeType: decoded.mimeType,
          sizeBytes: decoded.body.byteLength,
          fileName,
          storageKey,
          provider: result.provider,
          providerModel: result.providerModel,
          routeDecision: result.routeDecision,
          revisedPrompt: image.revisedPrompt,
          width: image.width,
          height: image.height,
        },
      });

      const artifactUrl = buildArtifactPreviewUrl({
        workspaceId: input.workspaceId,
        artifactId,
      });

      emitProgress("billing", {
        artifactId,
        artifactUrl,
        versionId,
      });
      await meterBillableModelUsage({
        billing: input.billing,
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        actorUserId: input.userId,
        feature: "artifact.image",
        operation: "images.generate",
        modelKind: "image",
        gatewayConfigId: input.profile.gatewayConfigId,
        profileAlias: input.profile.profileAlias,
        modelAlias:
          input.execution?.executionMode === "BYOK"
            ? input.execution.modelAlias ??
              input.execution.providerModel ??
              input.profile.modelAlias
            : input.profile.modelAlias,
        referenceId: `artifact:${artifactId}`,
        idempotencyKey: `artifact-image:${artifactId}`,
        usage: result.usage,
        llm: input.execution,
        metadata: {
          traceId: input.traceId,
          threadId: input.threadId,
          messageId: input.userMessageId,
          toolCallId,
          artifactId,
          versionId,
          provider: result.provider,
          providerModel: result.providerModel,
          routeDecision: result.routeDecision,
          imageCount: result.images.length,
          aspectRatio: input.config.aspectRatio,
          quality: input.config.quality,
          style: input.config.style,
        },
      });

      emitProgress("ready", {
        artifactId,
        artifactUrl,
        height: image.height,
        versionId,
        provider: result.provider,
        providerModel: result.providerModel,
        width: image.width,
      });

      return formatToolResult({
        artifactId,
        versionId,
        title,
        artifactUrl,
        config: input.config,
        height: image.height,
        provider: result.provider,
        providerModel: result.providerModel,
        width: image.width,
      });
    },
    {
      name: AGENT_TOOL_NAMES.generateImage,
      description:
        "Generate one persisted SourceWeft image artifact from a visual prompt. Use this when the user's goal is to create a new visual artifact or deliverable, not when they only want to discuss, analyze, or summarize an existing image. Expand vague visual requests into a concise, concrete prompt with subject, composition, style, and mood. The tool returns a stable backend artifact URL.",
      schema: z.object({
        prompt: z.string().trim().min(1).max(4000),
        title: z.string().trim().min(1).max(160).optional(),
      }),
    },
  );
}
