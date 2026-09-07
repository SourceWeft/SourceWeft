import { randomUUID } from "node:crypto";
import { tool, type ToolRuntime } from "langchain";
import type {
  ImageGenerateInput,
  ImageGenerateResult,
} from "@sourceweft/model-gateway";
import { GENERATE_IMAGE_TOOL_NAME } from "./agent-tool-defs";
import { readGenerateImageTurnState } from "./turn-preflight";
import {
  buildImageToolResult,
  generateImageSchema,
  generatedImageProvenance,
  imageFileExtensionForMimeType,
  sanitizeImageArtifactFileBase,
} from "./image-tools";
import { buildImageRuntimePromptLines as buildPackageImageRuntimePromptLines } from "./image-tools";
import { compactArtifactText } from "./artifact-text";
import { buildArtifactPreviewUrl } from "./artifact-urls";
import {
  ARTIFACT_LIMITS,
  isArtifactImageMimeType,
  sniffImageMimeType,
} from "@sourceweft/contracts/artifact-files";
import { ArtifactError } from "@sourceweft/contracts/artifact-errors";
import {
  resolveAgentToolHostInvocationSignal,
  type AgentToolModelCallOptions,
} from "@sourceweft/contracts/agent-tools";
import type {
  ArtifactPublisher,
  ArtifactPublishSpec,
} from "@sourceweft/contracts/artifact-write";
import type { ArtifactImageConfig } from "./image-types";

export {
  DEFAULT_IMAGE_ARTIFACT_CONFIG,
  type ArtifactImageConfig,
  type ArtifactIntentDecision,
  type GenerateImageToolSelection,
  type ImageModelCapabilities,
} from "./image-types";
export { normalizeGenerateImageToolSelection } from "./image-config";
export { resolveGenerateImageIntentDecision } from "./intent";
export { resolveImageModelCapabilities } from "./image-capabilities";

export const GENERATED_IMAGE_PROGRESS_EVENT_TYPE = "generate_image_progress";

// ── Backend dependency interfaces ───────────────────────────────────────────

/**
 * The gateway settles billing for the call it makes, so it needs the billing
 * identity alongside the request. The host supplies a gateway that charges;
 * this package no longer meters separately.
 */
/**
 * The billing identity for one model call. Shared host vocabulary, aliased
 * under this package's own name so existing call sites keep reading naturally.
 */
export type ImageToolGenerateOptions = AgentToolModelCallOptions;

export interface ImageToolModelGateway {
  images: {
    generate(
      request: ImageGenerateInput,
      opts: ImageToolGenerateOptions,
    ): Promise<ImageGenerateResult>;
  };
}

export interface ImageToolArtifacts {
  /**
   * The host's shared artifact writer, narrowed to the one call this tool
   * makes. Object storage is no longer a dependency of this package: the writer
   * owns key construction and upload, which is why an image artifact publishes
   * through the generic, handler-less write path.
   */
  publishArtifact: ArtifactPublisher["publishArtifact"];
}

export interface ImageToolRuntimeDeps {
  modelGateway: ImageToolModelGateway;
  artifacts: ImageToolArtifacts;
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
    /** The turn's preflight state, keyed by tool name. Ours is in there. */
    turnState?: Readonly<Record<string, unknown>>;
  }) {
    const artifactIntent = readGenerateImageTurnState(
      context.turnState,
      GENERATE_IMAGE_TOOL_NAME,
    )?.artifactIntent;
    if (artifactIntent?.kind !== "image") {
      return [];
    }
    if (artifactIntent.shouldInjectTool !== true) {
      const warnings = artifactIntent.warnings ?? [];
      return [
        "Image generation was requested or made available by a selected image skill, but generate_image is not available for this turn.",
        warnings.length > 0
          ? `Image generation availability warnings: ${warnings.join(", ")}.`
          : null,
        "Briefly tell the user that image generation is unavailable.",
      ].filter((line): line is string => line !== null);
    }
    return buildImageRuntimePromptLines({
      config: artifactIntent.config,
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

function throwImageToolAbortReason(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw (
    signal.reason ??
    new DOMException("The image tool invocation was aborted.", "AbortError")
  );
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

async function decodeGeneratedImage(
  image: {
    b64Json?: string;
    url?: string;
    mimeType?: string;
  },
  signal?: AbortSignal,
) {
  throwImageToolAbortReason(signal);
  if (image.b64Json) {
    const body = Buffer.from(image.b64Json, "base64");
    return {
      body,
      mimeType: sniffImageMimeType(body) ?? "application/octet-stream",
    };
  }

  if (!image.url) {
    throw new Error("The image provider did not return image bytes.");
  }

  const response = await fetch(image.url, signal ? { signal } : undefined);
  throwImageToolAbortReason(signal);
  if (!response.ok) {
    throw new Error(`Failed to download generated image: ${response.status}`);
  }
  const body = Buffer.from(await response.arrayBuffer());
  throwImageToolAbortReason(signal);
  return {
    body,
    mimeType: sniffImageMimeType(body) ?? "application/octet-stream",
  };
}

/**
 * The three content rules an image artifact has to pass, run before the writer
 * is called at all.
 *
 * They used to live in `publishPreparedArtifact`'s image type handler. `image`
 * is a top-level medium owned by no capability — it has no write handler, by
 * design — so there is nowhere in the shared writer for a type-specific rule to
 * live, and the package that produces the bytes is the one that must enforce
 * them.
 *
 * The codes are reproduced verbatim rather than mapped onto the writer's own
 * `ARTIFACT_ATTACHMENT_*` vocabulary: artifact error codes are a wire contract,
 * so an oversized image keeps reporting `ARTIFACT_FILE_TOO_LARGE`. All three are
 * already classified `validation` (i.e. recoverable) in
 * `ARTIFACT_ERROR_CATEGORY_BY_CODE`, so what the agent is told is unchanged too.
 *
 * Running here, before the spec is built, also means the attachment never needs
 * a `maxBytes`: nothing oversized reaches the writer.
 */
function assertPublishableImage(input: {
  bytes: Buffer;
  mimeType: string;
}): void {
  if (input.bytes.byteLength === 0) {
    throw new ArtifactError({
      code: "ARTIFACT_FILE_EMPTY",
      details: "file is empty",
    });
  }
  if (input.bytes.byteLength > ARTIFACT_LIMITS.imageBytes) {
    throw new ArtifactError({
      code: "ARTIFACT_FILE_TOO_LARGE",
      details: `${input.bytes.byteLength} bytes exceeds limit of ${ARTIFACT_LIMITS.imageBytes} bytes`,
    });
  }
  if (!isArtifactImageMimeType(input.mimeType)) {
    throw new ArtifactError({
      code: "ARTIFACT_SOURCE_INVALID",
      details: `expected image MIME type, received ${input.mimeType}`,
    });
  }
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
      const signal = resolveAgentToolHostInvocationSignal(runtime);
      throwImageToolAbortReason(signal);
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

      // Allocated before the call, not after publishing, so the billing key
      // exists for the call it protects. Deriving it from the published
      // artifact used to mean a failure between generating and publishing left
      // the tokens burned and nothing charged, and a retry produced a fresh id
      // and therefore a fresh key.
      const artifactId = randomUUID();

      const result = await deps.modelGateway.images.generate(request, {
        traceId: ctx.traceId,
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
        ...(signal ? { signal } : {}),
        llm: ctx.execution,
        billingMetadata: {
          traceId: ctx.traceId,
          threadId: ctx.threadId,
          messageId: ctx.userMessageId,
          toolCallId,
          artifactId,
          aspectRatio: ctx.config.aspectRatio,
          quality: ctx.config.quality,
          style: ctx.config.style,
        },
      });
      throwImageToolAbortReason(signal);
      const image = result.images[0];
      if (!image) {
        throw new Error("Image generation did not return an image.");
      }

      emitProgress("saving", {
        provider: result.provider,
        providerModel: result.providerModel,
      });
      const decoded = await decodeGeneratedImage(image, signal);
      const fileName = `${sanitizeImageArtifactFileBase(title)}${imageFileExtensionForMimeType(decoded.mimeType)}`;
      assertPublishableImage({
        bytes: decoded.body,
        mimeType: decoded.mimeType,
      });

      /**
       * The row this produces is field-for-field the one the old
       * `publishPreparedArtifact` path wrote, with exactly one omission:
       * `payload_json.storageKey`.
       *
       * The old publisher folded the object key into the payload after
       * uploading. It cannot be reproduced here, because the real
       * `buildArtifactStorageKey` embeds a `randomUUID()` — the caller cannot
       * predict the key, and the writer commits the payload in the same
       * transaction that sets the column. The only ways to keep it were to give
       * `image` a write handler (it must not have one: `image` has two
       * producers, so no single owner) or to let the generic writer mutate a
       * caller's payload on the handler-less path — which would break the
       * invariant that path is pinned on, "payload persisted exactly as the
       * caller supplied it".
       *
       * Dropping it is safe because the field has no readers: every consumer —
       * the artifacts service, the content routes, the web app — reads the
       * row's own `storage_key` column, and the payload copy was only ever a
       * duplicate of it. Existing rows keep theirs and stay readable.
       */
      const spec: ArtifactPublishSpec = {
        artifactType: "image",
        title,
        prompt,
        payload: {
          artifactType: "image",
          byteLength: decoded.body.byteLength,
          description: prompt,
          fileName,
          mimeType: decoded.mimeType,
          source: generatedImageProvenance(GENERATE_IMAGE_TOOL_NAME),
          title,
          prompt,
          config: ctx.config,
          sizeBytes: decoded.body.byteLength,
          provider: result.provider,
          providerModel: result.providerModel,
          routeDecision: result.routeDecision,
          revisedPrompt: image.revisedPrompt,
          width: image.width,
          height: image.height,
          toolCallId,
        },
        // The generated bytes are the artifact's own stored file, so they are
        // the primary attachment: that is what sets the row's storage_bucket /
        // storage_key and what "download this artifact" serves.
        attachments: [
          {
            fileName,
            contentType: decoded.mimeType,
            bytes: decoded.body,
            role: "primary",
          },
        ],
      };

      // The provider call is the long phase. Never enter the persistent writer
      // after the invocation deadline or user Stop won that race.
      throwImageToolAbortReason(signal);
      const published = await deps.artifacts.publishArtifact({
        artifactId,
        ...(signal ? { signal } : {}),
        context: {
          teamId: ctx.teamId,
          workspaceId: ctx.workspaceId,
          threadId: ctx.threadId,
          userId: ctx.userId,
        },
        spec,
      });
      const versionId = published.versionId;
      const artifactUrl = buildArtifactPreviewUrl({
        artifactId,
        workspaceId: ctx.workspaceId,
      });

      emitProgress("billing", {
        artifactId,
        artifactUrl,
        versionId,
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
