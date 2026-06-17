import {
  buildGatewayRequestMetadata,
  recordGatewayOperationEvent,
} from "../../../content/model-gateway-audit";
import { toContentError } from "../../../content/model-gateway-error";
import {
  getModelGatewayClient,
  resolveModelGatewayProfile,
} from "../../../../shared/model-gateway/client";
import { buildParsedDocument } from "./utils";
import type { ProviderParseInput, ProviderParseOutcome } from "./types";

const IMAGE_VISION_PROMPT = [
  "Describe this image in markdown.",
  "Transcribe any visible text verbatim.",
  "Do not invent content that is not visible.",
  "Do not wrap the response in a markdown code fence.",
  "Be concise but complete; let the image content guide the level of detail.",
].join(" ");

const MAX_IMAGE_VISION_BYTES = 5 * 1024 * 1024;

function buildImageDataUrl(input: { content: Buffer; mimeType: string }) {
  if (input.content.byteLength > MAX_IMAGE_VISION_BYTES) {
    throw new Error(
      `Image too large for vision extraction: ${input.content.byteLength} bytes`,
    );
  }

  return `data:${input.mimeType};base64,${input.content.toString("base64")}`;
}

function safeErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message.split("\n", 1)[0]?.slice(0, 240) || error.name;
  }

  return (
    String(error).split("\n", 1)[0]?.slice(0, 240) || "Vision extraction failed"
  );
}

function stripWrappingMarkdownFence(content: string) {
  const trimmed = content.trim();
  const match = trimmed.match(
    /^```(?:markdown|md)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/i,
  );
  const unwrapped = match?.[1];
  return unwrapped === undefined ? trimmed : unwrapped.trim();
}

export async function tryParseImageWithVision(
  input: ProviderParseInput,
): Promise<
  | { kind: "completed"; outcome: ProviderParseOutcome }
  | { kind: "fallback"; reason: string }
> {
  const startedAt = Date.now();
  let modelAlias: string | null = null;
  let profileAlias: string | null = null;

  try {
    const profile = await resolveModelGatewayProfile({
      kind: "vision",
      defaultRequired: true,
    });
    if (!profile) {
      throw new Error("Default vision model gateway profile is not configured");
    }

    modelAlias = profile.modelAlias;
    profileAlias = profile.profileAlias;
    const gateway = await getModelGatewayClient(profile.gatewayConfigId);
    const dataUrl = buildImageDataUrl({
      content: input.content,
      mimeType: input.mimeType,
    });

    const result = await gateway.chat.complete(
      {
        model: profile.modelAlias,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: IMAGE_VISION_PROMPT,
              },
              {
                type: "image_url",
                image_url: {
                  url: dataUrl,
                },
              },
            ],
          },
        ],
      },
      {
        traceId: input.sourceRevisionId ?? input.sourceId,
        metadata: buildGatewayRequestMetadata({
          teamId: input.teamId,
          workspaceId: input.workspaceId,
          userId: input.userId,
          feature: "source_ingestion",
          operation: "source.image_vision_extract",
          modelKind: "vision",
          modelAlias: profile.modelAlias,
          profileAlias: profile.profileAlias,
        }),
      },
    );

    const content =
      typeof result.raw.content === "string"
        ? stripWrappingMarkdownFence(result.raw.content)
        : stripWrappingMarkdownFence(String(result.raw.content ?? ""));
    if (!content) {
      throw new Error("Vision model returned empty content");
    }

    await recordGatewayOperationEvent({
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      feature: "source_ingestion",
      operation: "source.image_vision_extract",
      modelKind: "vision",
      modelAlias: profile.modelAlias,
      profileAlias: profile.profileAlias,
      provider: result.provider,
      routeDecision: result.routeDecision as unknown as Record<
        string,
        unknown
      > | null,
      usage: result.usage,
      traceId: input.sourceRevisionId ?? input.sourceId,
      success: true,
      latencyMs: Date.now() - startedAt,
      attributes: {
        sourceId: input.sourceId,
        sourceRevisionId: input.sourceRevisionId,
        fileName: input.fileName,
        mimeType: input.mimeType,
        billable: false,
        billingReason: "covered_by_ingestion_page",
      },
    });

    const document = await buildParsedDocument({
      parseInput: input,
      content,
      pages: [{ pageNumber: 1, content }],
      metadata: {
        pageCount: 1,
        documentParseBackend: "vision",
        documentParseProvider: "vision",
        documentParseProviderResolved: "vision",
        documentParseMode: "image_vision",
        visionModelAlias: profile.modelAlias,
        visionProfileAlias: profile.profileAlias,
      },
    });

    return {
      kind: "completed",
      outcome: {
        kind: "completed",
        document,
        diagnostics: {
          metadata: document.metadata,
        },
      },
    };
  } catch (error) {
    const reason = safeErrorMessage(error);
    const contentError = toContentError(error);
    await recordGatewayOperationEvent({
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      feature: "source_ingestion",
      operation: "source.image_vision_extract",
      modelKind: "vision",
      modelAlias,
      profileAlias,
      traceId: input.sourceRevisionId ?? input.sourceId,
      success: false,
      errorCode: contentError.code,
      errorMessage: contentError.message,
      latencyMs: Date.now() - startedAt,
      attributes: {
        sourceId: input.sourceId,
        sourceRevisionId: input.sourceRevisionId,
        fileName: input.fileName,
        mimeType: input.mimeType,
        billable: false,
        billingReason: "covered_by_ingestion_page",
        visionFallbackReason: reason,
      },
    });

    return {
      kind: "fallback",
      reason,
    };
  }
}

export const testExports = {
  buildImageDataUrl,
  stripWrappingMarkdownFence,
  IMAGE_VISION_PROMPT,
};
