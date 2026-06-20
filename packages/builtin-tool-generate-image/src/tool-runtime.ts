import { tool, type ToolRuntime } from "langchain";
import type { ImageGenerateInput, ImageGenerateResult } from "@sourceweft/model-gateway";
import { publishPreparedArtifact } from "@sourceweft/builtin-tool-publish-artifact";
import { GENERATE_IMAGE_TOOL_NAME } from "./agent-tool-defs";
import {
  buildImageToolResult,
  generateImageSchema,
  sanitizeImageArtifactFileBase,
} from "./image-tools";
import { buildImageRuntimePromptLines as buildPackageImageRuntimePromptLines } from "./image-tools";
import { compactArtifactText } from "./artifact-text";
import type { ArtifactImageConfig } from "./image-types";

export {
  DEFAULT_IMAGE_ARTIFACT_CONFIG,
  type ArtifactImageConfig,
  type ArtifactIntentDecision,
  type GenerateImageToolSelection,
  type ImageModelCapabilities,
} from "./image-types";
export { normalizeArtifactToolSelection, normalizeGenerateImageToolSelection } from "./image-config";
export { resolveGenerateImageIntentDecision } from "./intent";
export { resolveImageModelCapabilities } from "./image-capabilities";

export const GENERATED_IMAGE_PROGRESS_EVENT_TYPE = "generate_image_progress";

// ── Backend dependency interfaces ───────────────────────────────────────────

export interface ImageToolModelGateway {
  images: {
    generate(
      request: ImageGenerateInput,
      opts?: { traceId?: string; metadata?: Record<string, unknown> },
    ): Promise<ImageGenerateResult>;
  };
}

export interface ImageToolStorage {
  buildStorageKey(input: {
    workspaceId: string;
    artifactId: string;
    fileName: string;
  }): string;
  getBucketName(): string;
  upload(input: {
    key: string;
    body: Buffer;
    contentType: string;
  }): Promise<void>;
}

export interface ImageToolArtifactRecord {
  artifactId: string;
  versionId: string;
}

export interface ImageToolArtifacts {
  createRecord(input: {
    artifactId: string;
    teamId: string;
    workspaceId: string;
    threadId: string;
    userId: string;
    title: string;
    prompt: string;
    storageBucket: string;
    storageKey: string;
    payload: Record<string, unknown>;
  }): Promise<ImageToolArtifactRecord>;
}

export interface ImageToolBilling {
  meterUsage(input: {
    teamId: string;
    workspaceId: string;
    actorUserId: string;
    feature: string;
    operation: string;
    modelKind: string;
    gatewayConfigId: string;
    profileAlias: string;
    modelAlias: string;
    referenceId: string;
    idempotencyKey: string;
    usage: unknown;
    llm: unknown;
    metadata: Record<string, unknown>;
  }): Promise<void>;
}

export interface ImageToolRuntimeDeps {
  modelGateway: ImageToolModelGateway;
  storage: ImageToolStorage;
  artifacts: ImageToolArtifacts;
  billing: ImageToolBilling;
}

export interface ImageToolContext {
  teamId: string;
  workspaceId: string;
  threadId: string;
  userId: string;
  userMessageId: string;
  traceId?: string;
  parentSpanId?: string;
  profile: {
    gatewayConfigId: string;
    profileAlias: string;
    modelAlias: string;
  };
  execution?: {
    executionMode?: string;
    modelAlias?: string;
    providerModel?: string;
    byokModelId?: string;
    credentialId?: string;
  };
  config: ArtifactImageConfig;
}

// ── Runtime prompt ──────────────────────────────────────────────────────────

export function buildImageRuntimePromptLines(input: {
  config: ArtifactImageConfig;
}): string[] {
  return buildPackageImageRuntimePromptLines({
    config: input.config,
    toolName: GENERATE_IMAGE_TOOL_NAME,
  });
}

export const imageRuntimePromptProvider = {
  buildLines(context: {
    artifactIntent?: {
      kind: string;
      shouldInjectTool?: boolean;
      config: ArtifactImageConfig;
      warnings?: readonly string[];
    };
  }) {
    if (context.artifactIntent?.kind !== "image") {
      return [];
    }
    if (context.artifactIntent.shouldInjectTool !== true) {
      const warnings = context.artifactIntent.warnings ?? [];
      return [
        "Image generation was requested or made available by a selected image skill, but generate_image is not available for this turn.",
        warnings.length > 0
          ? `Image generation availability warnings: ${warnings.join(", ")}.`
          : null,
        "Briefly tell the user that image generation is unavailable.",
      ].filter((line): line is string => line !== null);
    }
    return buildImageRuntimePromptLines({
      config: context.artifactIntent.config,
    });
  },
};

// ── Tool factory ────────────────────────────────────────────────────────────

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
  profile: ImageToolContext["profile"];
  execution?: ImageToolContext["execution"];
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
      ? (input.execution?.modelAlias ??
        input.execution?.providerModel ??
        input.profile.modelAlias)
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

export function createGenerateImageTool(
  ctx: ImageToolContext,
  deps: ImageToolRuntimeDeps,
) {
  return tool(
    async (
      args: {
        prompt: string;
        title?: string;
      },
      runtime: ToolRuntime,
    ) => {
      const prompt = args.prompt.trim();
      const title = (
        args.title?.trim() || compactArtifactText(prompt, 80)
      ).slice(0, 160);
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
          tool: GENERATE_IMAGE_TOOL_NAME,
          stage,
          prompt,
          title,
          ...metadata,
        });
      };

      emitProgress("preparing", {
        aspectRatio: ctx.config.aspectRatio,
        quality: ctx.config.quality,
        style: ctx.config.style,
      });

      const request: ImageGenerateInput = {
        model:
          ctx.execution?.executionMode === "BYOK"
            ? (ctx.execution.providerModel ??
              ctx.execution.modelAlias ??
              ctx.profile.modelAlias)
            : ctx.profile.profileAlias,
        ...(ctx.execution ? (ctx.execution as Record<string, unknown>) : {}),
        prompt,
        aspectRatio: ctx.config.aspectRatio,
        quality: ctx.config.quality,
        style: ctx.config.style,
        count: 1,
        responseFormat: "b64_json",
        metadata: buildImageGatewayMetadata({
          traceId: ctx.traceId,
          parentSpanId: ctx.parentSpanId,
          profile: ctx.profile,
          execution: ctx.execution,
          teamId: ctx.teamId,
          workspaceId: ctx.workspaceId,
          userId: ctx.userId,
          threadId: ctx.threadId,
          userMessageId: ctx.userMessageId,
          toolCallId,
        }),
      };

      emitProgress("generating", {
        providerModel: request.model,
      });
      const result = await deps.modelGateway.images.generate(request, {
        traceId: ctx.traceId,
        metadata: {
          parentSpanId: ctx.parentSpanId,
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
      const fileName = `${sanitizeImageArtifactFileBase(title)}.png`;

      const published = await publishPreparedArtifact({
        context: {
          teamId: ctx.teamId,
          workspaceId: ctx.workspaceId,
          threadId: ctx.threadId,
          userId: ctx.userId,
        },
        descriptor: {
          artifactType: "image",
          title,
          description: prompt,
          source: {
            kind: "generated_image",
            tool: GENERATE_IMAGE_TOOL_NAME,
          },
        },
        source: {
          bytes: decoded.body,
          mimeType: decoded.mimeType,
          path: fileName,
          payload: {
            prompt,
            config: ctx.config,
            sizeBytes: decoded.body.byteLength,
            provider: result.provider,
            providerModel: result.providerModel,
            routeDecision: result.routeDecision,
            revisedPrompt: image.revisedPrompt,
            width: image.width,
            height: image.height,
          },
        },
        services: {
          artifacts: {
            createImageArtifactRecord: deps.artifacts.createRecord,
          },
          storage: {
            buildArtifactStorageKey: deps.storage.buildStorageKey,
            getContentStorageBucketName: deps.storage.getBucketName,
            uploadArtifactObject: deps.storage.upload,
          },
        },
        toolCallId,
      });
      const artifactId = published.artifactId;
      const versionId = published.record.versionId;
      const artifactUrl = published.output.artifactUrl;

      emitProgress("billing", {
        artifactId,
        artifactUrl,
        versionId,
      });
      await deps.billing.meterUsage({
        teamId: ctx.teamId,
        workspaceId: ctx.workspaceId,
        actorUserId: ctx.userId,
        feature: "artifact.image",
        operation: "images.generate",
        modelKind: "image",
        gatewayConfigId: ctx.profile.gatewayConfigId,
        profileAlias: ctx.profile.profileAlias,
        modelAlias:
          ctx.execution?.executionMode === "BYOK"
            ? (ctx.execution.modelAlias ??
              ctx.execution.providerModel ??
              ctx.profile.modelAlias)
            : ctx.profile.modelAlias,
        referenceId: `artifact:${artifactId}`,
        idempotencyKey: `artifact-image:${artifactId}`,
        usage: result.usage,
        llm: ctx.execution,
        metadata: {
          traceId: ctx.traceId,
          threadId: ctx.threadId,
          messageId: ctx.userMessageId,
          toolCallId,
          artifactId,
          versionId,
          provider: result.provider,
          providerModel: result.providerModel,
          routeDecision: result.routeDecision,
          imageCount: result.images.length,
          aspectRatio: ctx.config.aspectRatio,
          quality: ctx.config.quality,
          style: ctx.config.style,
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

      return buildImageToolResult({
        artifactId,
        versionId,
        title,
        artifactUrl,
        config: ctx.config,
        height: image.height,
        provider: result.provider,
        providerModel: result.providerModel,
        width: image.width,
      });
    },
    {
      name: GENERATE_IMAGE_TOOL_NAME,
      description:
        "Internal SourceWeft image artifact executor. Call only when an image skill runtime or compatibility command explicitly enables this tool. Generate one persisted image artifact from a concise visual prompt; do not use this tool for ordinary chat or passive analysis. The tool publishes the image artifact and returns artifact metadata for the application to display.",
      schema: generateImageSchema,
    },
  );
}
