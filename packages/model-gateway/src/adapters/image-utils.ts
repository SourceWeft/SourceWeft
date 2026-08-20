import { createHttpGatewayError, ModelGatewayError } from "../errors";
import { normalizeProviderUsage } from "../normalize/usage";
import type {
  GeneratedImage,
  ImageAspectRatio,
  ImageGenerateInput,
  ImageGenerateResult,
  ImageQuality,
  ImageStyle,
  ResolvedRequestTarget,
  UsageInfo,
} from "../types";

const STYLE_PROMPTS: Record<Exclude<ImageStyle, "auto">, string> = {
  cartoon: "Use a clean cartoon illustration style.",
  ghibli: "Use a warm hand-painted animation-inspired style.",
  pixel: "Use a crisp pixel art style.",
  pixar: "Use a polished 3D animated film style.",
};

export function applyImageStylePrompt(input: ImageGenerateInput) {
  const style = input.style;
  if (!style || style === "auto") {
    return input.prompt;
  }

  return `${input.prompt.trim()}\n\nStyle: ${STYLE_PROMPTS[style]}`;
}

export function mapAspectRatioToOpenAIImageSize(
  aspectRatio: ImageAspectRatio | undefined,
) {
  switch (aspectRatio) {
    case "1:1":
      return "1024x1024";
    case "2:3":
      return "832x1248";
    case "3:2":
      return "1248x832";
    case "3:4":
      return "864x1184";
    case "4:3":
      return "1184x864";
    case "4:5":
      return "896x1152";
    case "5:4":
      return "1152x896";
    case "9:16":
      return "768x1344";
    case "16:9":
      return "1344x768";
    case "21:9":
      return "1536x672";
    case "auto":
    case undefined:
      return "1024x1024";
    default:
      return "1024x1024";
  }
}

export function mapQualityToOpenAIQuality(quality: ImageQuality | undefined) {
  if (quality === "higher" || quality === "highest") {
    return "hd";
  }
  if (quality === "low" || quality === "standard") {
    return "standard";
  }
  return undefined;
}

export function mapQualityToResolutionName(quality: ImageQuality | undefined) {
  switch (quality) {
    case "low":
      return "512x512";
    case "standard":
      return "1024x1024";
    case "higher":
      return "2048x2048";
    case "highest":
      return "4096x4096";
    default:
      return undefined;
  }
}

export async function parseJsonResponse(response: Response) {
  const text = await response.text();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    if (!response.ok) {
      return { message: text };
    }
    throw new ModelGatewayError({
      code: "UPSTREAM",
      message: "Image generation provider returned invalid JSON",
      retryable: true,
    });
  }
}

export function throwIfHttpError(response: Response, body: Record<string, unknown>) {
  if (response.ok) {
    return;
  }

  throw createHttpGatewayError({
    statusCode: response.status,
    body,
    requestId:
      response.headers.get("x-request-id") ??
      response.headers.get("cf-ray") ??
      undefined,
  });
}

function compactImage(image: GeneratedImage): GeneratedImage {
  return Object.fromEntries(
    Object.entries(image).filter(([, value]) => value !== undefined),
  ) as GeneratedImage;
}

function normalizeMimeType(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeUrl(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeBase64(value: unknown) {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  const dataUrlMatch = value.match(/^data:([^;]+);base64,(.+)$/);
  return dataUrlMatch?.[2] ?? value;
}

function normalizeDimension(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function imageFromRecord(record: Record<string, unknown>): GeneratedImage | null {
  const imageUrl =
    record.image_url && typeof record.image_url === "object"
      ? (record.image_url as Record<string, unknown>)
      : null;
  const image =
    record.image && typeof record.image === "object"
      ? (record.image as Record<string, unknown>)
      : null;

  const url = normalizeUrl(record.url) ?? normalizeUrl(imageUrl?.url) ?? normalizeUrl(image?.url);
  const b64Json =
    normalizeBase64(record.b64_json) ??
    normalizeBase64(record.b64Json) ??
    normalizeBase64(record.data) ??
    normalizeBase64(imageUrl?.b64_json) ??
    normalizeBase64(imageUrl?.b64Json) ??
    normalizeBase64(image?.b64_json) ??
    normalizeBase64(image?.b64Json) ??
    normalizeBase64(image?.data);

  if (!url && !b64Json) {
    return null;
  }

  return compactImage({
    url,
    b64Json,
    mimeType:
      normalizeMimeType(record.mime_type) ??
      normalizeMimeType(record.mimeType) ??
      normalizeMimeType(imageUrl?.mime_type) ??
      normalizeMimeType(image?.mime_type) ??
      (b64Json ? "image/png" : undefined),
    revisedPrompt:
      typeof record.revised_prompt === "string"
        ? record.revised_prompt
        : typeof record.revisedPrompt === "string"
          ? record.revisedPrompt
          : undefined,
    width: normalizeDimension(record.width ?? imageUrl?.width ?? image?.width),
    height: normalizeDimension(record.height ?? imageUrl?.height ?? image?.height),
  });
}

export function normalizeGeneratedImages(raw: Record<string, unknown>) {
  const candidates: unknown[] = [];

  if (Array.isArray(raw.data)) {
    candidates.push(...raw.data);
  }
  if (Array.isArray(raw.images)) {
    candidates.push(...raw.images);
  }

  const choices = Array.isArray(raw.choices) ? raw.choices : [];
  for (const choice of choices) {
    if (!choice || typeof choice !== "object") {
      continue;
    }
    const message = (choice as Record<string, unknown>).message;
    if (!message || typeof message !== "object") {
      continue;
    }
    const messageRecord = message as Record<string, unknown>;
    if (Array.isArray(messageRecord.images)) {
      candidates.push(...messageRecord.images);
    }
    if (messageRecord.image) {
      candidates.push(messageRecord.image);
    }

    if (Array.isArray(messageRecord.tool_calls)) {
      for (const toolCall of messageRecord.tool_calls) {
        if (!toolCall || typeof toolCall !== "object") {
          continue;
        }
        const toolCallRecord = toolCall as Record<string, unknown>;
        const functionRecord =
          toolCallRecord.function &&
          typeof toolCallRecord.function === "object" &&
          !Array.isArray(toolCallRecord.function)
            ? (toolCallRecord.function as Record<string, unknown>)
            : null;
        const rawArguments = functionRecord?.arguments ?? toolCallRecord.arguments;
        const parsedArguments =
          typeof rawArguments === "string"
            ? (() => {
                try {
                  return JSON.parse(rawArguments) as unknown;
                } catch {
                  return null;
                }
              })()
            : rawArguments;
        if (!parsedArguments || typeof parsedArguments !== "object") {
          continue;
        }
        const argumentsRecord = parsedArguments as Record<string, unknown>;
        if (Array.isArray(argumentsRecord.images)) {
          candidates.push(...argumentsRecord.images);
        }
        if (argumentsRecord.image) {
          candidates.push(argumentsRecord.image);
        }
        if (argumentsRecord.url || argumentsRecord.b64_json || argumentsRecord.b64Json) {
          candidates.push(argumentsRecord);
        }
      }
    }
  }

  return candidates
    .map((candidate) =>
      candidate && typeof candidate === "object"
        ? imageFromRecord(candidate as Record<string, unknown>)
        : null,
    )
    .filter((image): image is GeneratedImage => image !== null);
}

export function assertGeneratedImages(images: GeneratedImage[]) {
  if (images.length > 0) {
    return;
  }

  throw new ModelGatewayError({
    code: "UPSTREAM",
    message: "Image generation provider did not return an image",
    retryable: true,
  });
}

export function buildImageGenerateResult(input: {
  raw: Record<string, unknown>;
  target: ResolvedRequestTarget;
  images: GeneratedImage[];
  usage?: UsageInfo;
  /** Resolved provider request size (`WxH`) + quality, for per-image pricing. */
  imageSize?: string;
  imageQuality?: string;
  traceId?: string;
}): ImageGenerateResult {
  const usage = input.usage ?? normalizeProviderUsage(input.raw);
  const imageUsage =
    usage || input.images.length > 0
      ? {
          ...usage,
          outputImageCount: usage?.outputImageCount ?? input.images.length,
          ...(input.imageSize ? { imageSize: input.imageSize } : {}),
          ...(input.imageQuality ? { imageQuality: input.imageQuality } : {}),
        }
      : usage;

  return {
    model:
      typeof input.raw.model === "string"
        ? input.raw.model
        : input.target.providerModel,
    images: input.images,
    usage: imageUsage,
    provider: input.target.provider,
    providerModel: input.target.providerModel,
    routeDecision: input.target.routeDecision,
    traceId: input.traceId,
    raw: input.raw,
  };
}
