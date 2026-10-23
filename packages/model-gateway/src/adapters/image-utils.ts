import { createHttpGatewayError, ModelGatewayError } from "../errors";
import { normalizeModelCallObservation } from "../observation/normalize";
import {
  DEFAULT_IMAGE_GENERATION_REQUEST,
  type GeneratedImage,
  type ImageAspectRatio,
  type ImageGenerateInput,
  type ImageGenerateResult,
  type ImageGenerationEndpoint,
  type ImageGenerationRequestConfig,
  type ImageGenerationSizing,
  type ImageQuality,
  type ImageStyle,
  type ResolvedRequestTarget,
  type UsageInfo,
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

export function isImageGenerationEndpoint(
  value: unknown,
): value is ImageGenerationEndpoint {
  return value === "openai" || value === "native";
}

export function isImageGenerationSizing(
  value: unknown,
): value is ImageGenerationSizing {
  return value === "size" || value === "dimensions" || value === "aspect_ratio";
}

/**
 * The request conventions a target was configured with. Anything missing
 * falls back to the OpenAI `images/generations` + `size` path, so a profile
 * without the block keeps today's wire format.
 */
export function resolveImageGenerationRequestConfig(
  target: Pick<ResolvedRequestTarget, "imageGeneration">,
): ImageGenerationRequestConfig {
  const request = target.imageGeneration?.request;
  return {
    endpoint: isImageGenerationEndpoint(request?.endpoint)
      ? request.endpoint
      : DEFAULT_IMAGE_GENERATION_REQUEST.endpoint,
    sizing: isImageGenerationSizing(request?.sizing)
      ? request.sizing
      : DEFAULT_IMAGE_GENERATION_REQUEST.sizing,
  };
}

export function mapAspectRatioToImageDimensions(
  aspectRatio: ImageAspectRatio | undefined,
): { width: number; height: number } {
  const [width, height] = mapAspectRatioToOpenAIImageSize(aspectRatio)
    .split("x")
    .map((value) => Number.parseInt(value, 10));
  return { width: width!, height: height! };
}

/**
 * Pixel envelope accepted by provider-native inference endpoints that take
 * explicit `width`/`height` (DeepInfra's schemas: 256–1440, multiples of 16).
 * Both edges are scaled together before rounding so the ratio survives.
 */
export const NATIVE_IMAGE_DIMENSION_MIN = 256;
export const NATIVE_IMAGE_DIMENSION_MAX = 1440;
export const NATIVE_IMAGE_DIMENSION_STEP = 16;

function snapDimension(value: number) {
  const snapped =
    Math.round(value / NATIVE_IMAGE_DIMENSION_STEP) * NATIVE_IMAGE_DIMENSION_STEP;
  return Math.min(
    NATIVE_IMAGE_DIMENSION_MAX,
    Math.max(NATIVE_IMAGE_DIMENSION_MIN, snapped),
  );
}

export function fitImageDimensionsToNativeEnvelope(input: {
  width: number;
  height: number;
}): { width: number; height: number } {
  const longest = Math.max(input.width, input.height);
  // Never scale up: an edge below the minimum is raised by the clamp alone.
  const scale = Math.min(1, NATIVE_IMAGE_DIMENSION_MAX / longest);
  return {
    width: snapDimension(input.width * scale),
    height: snapDimension(input.height * scale),
  };
}

/**
 * Aspect ratios provider-native endpoints accept by name. Everything else is
 * sent as `custom` with explicit dimensions. This list mirrors the enum shared
 * by DeepInfra's native image schemas, not any one model.
 */
export const NATIVE_IMAGE_ASPECT_RATIOS: readonly ImageAspectRatio[] = [
  "1:1",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "3:2",
  "2:3",
];

/**
 * The size-related fields for one request, by configured sizing convention.
 * `auto` (or no ratio) sends nothing so the provider applies its own default
 * instead of a 1:1 square the caller never asked for; the OpenAI `size` path
 * keeps sending the square because that is what it always sent.
 */
export function buildImageSizingFields(
  sizing: ImageGenerationSizing,
  aspectRatio: ImageAspectRatio | undefined,
): Record<string, unknown> {
  if (sizing === "size") {
    return { size: mapAspectRatioToOpenAIImageSize(aspectRatio) };
  }
  if (!aspectRatio || aspectRatio === "auto") {
    return {};
  }
  const dimensions = fitImageDimensionsToNativeEnvelope(
    mapAspectRatioToImageDimensions(aspectRatio),
  );
  if (sizing === "dimensions") {
    return dimensions;
  }
  if (NATIVE_IMAGE_ASPECT_RATIOS.includes(aspectRatio)) {
    return { aspect_ratio: aspectRatio };
  }
  return { aspect_ratio: "custom", ...dimensions };
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

export function throwIfHttpError(
  response: Response,
  body: Record<string, unknown>,
) {
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

function readUint32BE(bytes: Uint8Array, offset: number) {
  return (
    ((bytes[offset]! << 24) >>> 0) +
    (bytes[offset + 1]! << 16) +
    (bytes[offset + 2]! << 8) +
    bytes[offset + 3]!
  );
}

function readUint16BE(bytes: Uint8Array, offset: number) {
  return (bytes[offset]! << 8) + bytes[offset + 1]!;
}

function readUint16LE(bytes: Uint8Array, offset: number) {
  return bytes[offset]! + (bytes[offset + 1]! << 8);
}

function readUint24LE(bytes: Uint8Array, offset: number) {
  return (
    bytes[offset]! + (bytes[offset + 1]! << 8) + (bytes[offset + 2]! << 16)
  );
}

function asciiAt(bytes: Uint8Array, offset: number, length: number) {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

/**
 * Pixel dimensions from the container header of a PNG, JPEG, WebP or GIF.
 * Providers that return a bare data URL say nothing about the size, and the
 * caller records width/height on the stored artifact.
 */
export function readImageDimensions(
  bytes: Uint8Array,
): { width: number; height: number } | undefined {
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    asciiAt(bytes, 1, 3) === "PNG" &&
    asciiAt(bytes, 12, 4) === "IHDR"
  ) {
    return { width: readUint32BE(bytes, 16), height: readUint32BE(bytes, 20) };
  }
  if (bytes.length >= 10 && asciiAt(bytes, 0, 6).startsWith("GIF8")) {
    return { width: readUint16LE(bytes, 6), height: readUint16LE(bytes, 8) };
  }
  if (
    bytes.length >= 30 &&
    asciiAt(bytes, 0, 4) === "RIFF" &&
    asciiAt(bytes, 8, 4) === "WEBP"
  ) {
    const chunk = asciiAt(bytes, 12, 4);
    if (chunk === "VP8X") {
      return {
        width: readUint24LE(bytes, 24) + 1,
        height: readUint24LE(bytes, 27) + 1,
      };
    }
    if (chunk === "VP8L") {
      const bits = readUint24LE(bytes, 21) + bytes[24]! * 0x1000000;
      return {
        width: (bits & 0x3fff) + 1,
        height: (Math.floor(bits / 0x4000) & 0x3fff) + 1,
      };
    }
    if (chunk === "VP8 ") {
      return {
        width: readUint16LE(bytes, 26) & 0x3fff,
        height: readUint16LE(bytes, 28) & 0x3fff,
      };
    }
    return undefined;
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1]!;
      if (marker === 0xff) {
        offset += 1;
        continue;
      }
      // Start-of-frame markers carry the frame size; skip other segments.
      const isStartOfFrame =
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc;
      if (isStartOfFrame) {
        return {
          height: readUint16BE(bytes, offset + 5),
          width: readUint16BE(bytes, offset + 7),
        };
      }
      if (marker === 0xd9 || marker === 0xda) {
        return undefined;
      }
      offset += 2 + readUint16BE(bytes, offset + 2);
    }
  }
  return undefined;
}

function imageFromString(value: string): GeneratedImage | null {
  const dataUrlMatch = value.match(/^data:([^;,]+);base64,(.+)$/s);
  if (dataUrlMatch) {
    const b64Json = dataUrlMatch[2]!.replace(/\s+/g, "");
    let dimensions: { width: number; height: number } | undefined;
    try {
      dimensions = readImageDimensions(Buffer.from(b64Json, "base64"));
    } catch {
      dimensions = undefined;
    }
    return compactImage({
      b64Json,
      mimeType: dataUrlMatch[1],
      width: dimensions?.width,
      height: dimensions?.height,
    });
  }
  const url = normalizeUrl(value);
  return url ? compactImage({ url }) : null;
}

function imageFromRecord(
  record: Record<string, unknown>,
): GeneratedImage | null {
  const imageUrl =
    record.image_url && typeof record.image_url === "object"
      ? (record.image_url as Record<string, unknown>)
      : null;
  const image =
    record.image && typeof record.image === "object"
      ? (record.image as Record<string, unknown>)
      : null;

  const url =
    normalizeUrl(record.url) ??
    normalizeUrl(imageUrl?.url) ??
    normalizeUrl(image?.url);
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
      normalizeMimeType(image?.mime_type),
    revisedPrompt:
      typeof record.revised_prompt === "string"
        ? record.revised_prompt
        : typeof record.revisedPrompt === "string"
          ? record.revisedPrompt
          : undefined,
    width: normalizeDimension(record.width ?? imageUrl?.width ?? image?.width),
    height: normalizeDimension(
      record.height ?? imageUrl?.height ?? image?.height,
    ),
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
        const rawArguments =
          functionRecord?.arguments ?? toolCallRecord.arguments;
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
        if (
          argumentsRecord.url ||
          argumentsRecord.b64_json ||
          argumentsRecord.b64Json
        ) {
          candidates.push(argumentsRecord);
        }
      }
    }
  }

  return candidates
    .map((candidate) =>
      candidate && typeof candidate === "object"
        ? imageFromRecord(candidate as Record<string, unknown>)
        : typeof candidate === "string"
          ? imageFromString(candidate)
          : null,
    )
    .filter((image): image is GeneratedImage => image !== null);
}

/**
 * Provider-reported cost from a native inference reply
 * (`inference_status.cost`). Returned as the inline-cost patch the result
 * builder applies when the provider adapter did not already surface it.
 */
export function readInferenceStatusCost(
  raw: Record<string, unknown>,
  provider: string,
): { usd: number; provenance: string } | undefined {
  const status =
    raw.inference_status &&
    typeof raw.inference_status === "object" &&
    !Array.isArray(raw.inference_status)
      ? (raw.inference_status as Record<string, unknown>)
      : undefined;
  const cost = status?.cost;
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) {
    return undefined;
  }
  return {
    usd: cost,
    provenance: `provider:${provider.trim().toLowerCase()}.inference_status.cost`,
  };
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
  /** Actual provider charge read by the transport; used when no adapter set one. */
  providerCost?: { usd: number; provenance: string };
  traceId?: string;
}): ImageGenerateResult {
  const observation = normalizeModelCallObservation({
    modelAlias: input.target.routeDecision.alias,
    context: {
      target: input.target,
      modality: "image",
      rawResponse: input.raw,
    },
  });
  if (input.providerCost && observation.cost?.effectiveUsd === undefined) {
    observation.cost = {
      currency: "USD",
      inlineUsd: input.providerCost.usd,
      effectiveUsd: input.providerCost.usd,
      source: "provider_inline",
      status: "inline",
    };
    observation.provenance = {
      ...observation.provenance,
      inlineCost: input.providerCost.provenance,
    };
  }
  const usage = input.usage ?? observation.usage;
  const imageUsage =
    usage || input.images.length > 0
      ? {
          ...usage,
          outputImageCount: usage?.outputImageCount ?? input.images.length,
          ...(input.imageSize ? { imageSize: input.imageSize } : {}),
          ...(input.imageQuality ? { imageQuality: input.imageQuality } : {}),
        }
      : usage;
  observation.usage = imageUsage;

  return {
    model:
      typeof input.raw.model === "string"
        ? input.raw.model
        : input.target.providerModel,
    images: input.images,
    usage: imageUsage,
    observation,
    provider: input.target.provider,
    providerModel: input.target.providerModel,
    routeDecision: input.target.routeDecision,
    traceId: input.traceId,
    raw: input.raw,
  };
}
