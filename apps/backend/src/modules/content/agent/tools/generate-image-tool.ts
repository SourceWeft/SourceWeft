import { randomUUID } from "node:crypto";
import { tool, type ToolRuntime } from "langchain";
import { z } from "zod";
import type { ImageGenerateInput } from "@sourceweft/model-gateway";
import { getModelGatewayClient } from "../../../../shared/model-gateway/client";
import type { RuntimeModelGatewayProfile } from "../../../../shared/model-gateway/types";
import {
  buildArtifactStorageKey,
  getContentStorageBucketName,
  uploadArtifactObject,
} from "../../storage";
import { createImageArtifactRecord } from "../../artifacts/repository";
import type { ArtifactImageConfig } from "../../artifacts/types";

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
  provider?: string;
  providerModel?: string;
}) {
  return [
    "Image artifact created.",
    `artifact_id: ${input.artifactId}`,
    `version_id: ${input.versionId}`,
    `title: ${input.title}`,
    `artifact_url: ${input.artifactUrl}`,
    `aspect_ratio: ${input.config.aspectRatio}`,
    `quality: ${input.config.quality}`,
    `style: ${input.config.style}`,
    input.provider ? `provider: ${input.provider}` : null,
    input.providerModel ? `provider_model: ${input.providerModel}` : null,
    "The application will attach the generated image to the final answer. Do not repeat raw URLs.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
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
  config: ArtifactImageConfig;
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
      const gateway = await getModelGatewayClient(input.profile.gatewayConfigId);
      const request: ImageGenerateInput = {
        model: input.profile.profileAlias,
        prompt,
        aspectRatio: input.config.aspectRatio,
        quality: input.config.quality,
        style: input.config.style,
        count: 1,
        responseFormat: "b64_json",
        metadata: {
          traceId: input.traceId,
          parentSpanId: input.parentSpanId,
          profileAlias: input.profile.profileAlias,
          modelAlias: input.profile.modelAlias,
          teamId: input.teamId,
          workspaceId: input.workspaceId,
          userId: input.userId,
          threadId: input.threadId,
          messageId: input.userMessageId,
          toolCallId: runtime.toolCallId,
          observationName: "image_generation",
          feature: "artifact.image",
          modelKind: "image",
        },
      };

      const result = await gateway.images.generate(request, {
        traceId: input.traceId,
        metadata: {
          parentSpanId: input.parentSpanId,
          toolCallId: runtime.toolCallId,
        },
      });
      const image = result.images[0];
      if (!image) {
        throw new Error("Image generation did not return an image.");
      }

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

      const artifactUrl = `/v1/workspaces/${encodeURIComponent(input.workspaceId)}/artifacts/${encodeURIComponent(artifactId)}/file`;

      return formatToolResult({
        artifactId,
        versionId,
        title,
        artifactUrl,
        config: input.config,
        provider: result.provider,
        providerModel: result.providerModel,
      });
    },
    {
      name: "generate_image",
      description:
        "Generate one persisted SourceWeft image artifact from a visual prompt. Use this when the user's goal is to create a new visual artifact or deliverable, not when they only want to discuss, analyze, or summarize an existing image. Expand vague visual requests into a concise, concrete prompt with subject, composition, style, and mood. The tool returns a stable backend artifact URL.",
      schema: z.object({
        prompt: z.string().trim().min(1).max(4000),
        title: z.string().trim().min(1).max(160).optional(),
      }),
    },
  );
}
