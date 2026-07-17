import {
  videoPresentationCreateRequestSchema,
  videoPresentationRenderProfileSchema,
  type VideoPresentationCreateRequest,
} from "@sourceweft/contracts/video-presentation";
import { z } from "zod";

export const generateVideoPresentationSchema = z
  .object({
    brief: z.unknown().optional(),
    title: z.unknown().optional(),
    sourceDigest: z.unknown().optional(),
    audience: z.unknown().optional(),
    tone: z.unknown().optional(),
    language: z.unknown().optional(),
    durationTarget: z.unknown().optional(),
    stylePreset: z.unknown().optional(),
    renderProfile: z.unknown().optional(),
    slideCount: z.unknown().optional(),
    visualDirection: z.unknown().optional(),
    brand: z.unknown().optional(),
    motion: z.unknown().optional(),
    canvas: z.unknown().optional(),
    narrationEnabled: z.unknown().optional(),
    narration: z.unknown().optional(),
    assets: z.unknown().optional(),
    regeneration: z.unknown().optional(),
  })
  .passthrough();

export type GenerateVideoPresentationArgs = VideoPresentationCreateRequest;

const stylePresetSchema = videoPresentationRenderProfileSchema.shape.stylePreset;
const durationTargetSchema =
  videoPresentationRenderProfileSchema.shape.durationTarget;
const visualDensitySchema =
  videoPresentationRenderProfileSchema.shape.visualDensity;

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown, maxLength: number) {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim().slice(0, maxLength);
  return trimmed.length > 0 ? trimmed : undefined;
}

function readBoolean(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function readInteger(value: unknown, min: number, max: number) {
  const numberValue =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  if (!Number.isInteger(numberValue)) {
    return undefined;
  }
  return Math.min(max, Math.max(min, numberValue));
}

function readEnum<T>(schema: z.ZodType<T>, value: unknown) {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function readStringArray(value: unknown, maxItems: number, maxLength: number) {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value
    .map((item) => readString(item, maxLength))
    .filter((item): item is string => Boolean(item))
    .slice(0, maxItems);
  return items.length > 0 ? items : undefined;
}

function readAssetRefs(value: unknown) {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value
    .map((item) => {
      const record = readRecord(item);
      const assetId = readString(record.assetId, 160);
      const role = readString(record.role, 80);
      return assetId && role ? { assetId, role } : null;
    })
    .filter((item): item is { assetId: string; role: string } =>
      Boolean(item),
    );
}

function readRegeneration(value: unknown) {
  const record = readRecord(value);
  const artifactId = readString(record.artifactId, 160);
  const instruction = readString(record.instruction, 4000);
  const slideNumbers = Array.isArray(record.slideNumbers)
    ? record.slideNumbers
        .filter((item): item is number => Number.isInteger(item))
        .filter((item) => item >= 1 && item <= 80)
        .slice(0, 80)
    : undefined;
  if (!artifactId && !instruction && (!slideNumbers || slideNumbers.length === 0)) {
    return undefined;
  }
  return {
    ...(artifactId ? { artifactId } : {}),
    ...(instruction ? { instruction } : {}),
    ...(slideNumbers && slideNumbers.length > 0 ? { slideNumbers } : {}),
  };
}

function readBrand(value: unknown) {
  const record = readRecord(value);
  const colors = readStringArray(record.colors, 8, 80);
  const typography = readString(record.typography, 160);
  const logoAssetId = readString(record.logoAssetId, 160);
  if (!colors && !typography && !logoAssetId) {
    return undefined;
  }
  return {
    ...(colors ? { colors } : {}),
    ...(typography ? { typography } : {}),
    ...(logoAssetId ? { logoAssetId } : {}),
  };
}

function readMotion(value: unknown) {
  const record = readRecord(value);
  const pacing =
    record.pacing === "calm" ||
    record.pacing === "dynamic" ||
    record.pacing === "energetic"
      ? record.pacing
      : undefined;
  const transitionStyle = readString(record.transitionStyle, 160);
  const animationIntensity =
    record.animationIntensity === "subtle" ||
    record.animationIntensity === "balanced" ||
    record.animationIntensity === "bold"
      ? record.animationIntensity
      : undefined;
  if (!pacing && !transitionStyle && !animationIntensity) {
    return undefined;
  }
  return {
    ...(pacing ? { pacing } : {}),
    ...(transitionStyle ? { transitionStyle } : {}),
    ...(animationIntensity ? { animationIntensity } : {}),
  };
}

function readCanvas(value: unknown) {
  const record = readRecord(value);
  const width = readInteger(record.width, 640, 3840);
  const height = readInteger(record.height, 360, 2160);
  const fps = readInteger(record.fps, 12, 60);
  if (!width && !height && !fps) {
    return undefined;
  }
  return {
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
    ...(fps ? { fps } : {}),
  };
}

export function parseGenerateVideoPresentationArgs(
  input: unknown,
): GenerateVideoPresentationArgs {
  const rawInput =
    input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const raw = generateVideoPresentationSchema.parse(rawInput);
  const record = readRecord(raw);
  const renderProfileRecord = readRecord(record.renderProfile);
  const narrationRecord = readRecord(record.narration);
  const renderProfile = {
    stylePreset: readEnum(stylePresetSchema, renderProfileRecord.stylePreset),
    visualDensity: readEnum(
      visualDensitySchema,
      renderProfileRecord.visualDensity,
    ),
    durationTarget: readEnum(
      durationTargetSchema,
      renderProfileRecord.durationTarget,
    ),
    language: readString(renderProfileRecord.language, 20),
  };
  const hasRenderProfile = Object.values(renderProfile).some(
    (value) => value !== undefined,
  );
  const narrationEnabled = readBoolean(record.narrationEnabled);
  const narrationObjectEnabled = readBoolean(narrationRecord.enabled);
  const assets = readAssetRefs(record.assets);
  const regeneration = readRegeneration(record.regeneration);
  const brand = readBrand(record.brand);
  const motion = readMotion(record.motion);
  const canvas = readCanvas(record.canvas);

  return videoPresentationCreateRequestSchema.parse({
    brief: readString(record.brief, 50_000),
    title: readString(record.title, 180),
    sourceDigest: readString(record.sourceDigest, 50_000),
    audience: readString(record.audience, 300),
    tone: readString(record.tone, 200),
    language:
      readString(renderProfileRecord.language, 20) ??
      readString(record.language, 20),
    durationTarget:
      readEnum(durationTargetSchema, renderProfileRecord.durationTarget) ??
      readEnum(durationTargetSchema, record.durationTarget),
    stylePreset:
      readEnum(stylePresetSchema, renderProfileRecord.stylePreset) ??
      readEnum(stylePresetSchema, record.stylePreset),
    ...(hasRenderProfile ? { renderProfile } : {}),
    slideCount: readInteger(record.slideCount, 1, 12),
    visualDirection: readString(record.visualDirection, 1000),
    ...(brand ? { brand } : {}),
    ...(motion ? { motion } : {}),
    ...(canvas ? { canvas } : {}),
    ...(narrationEnabled !== undefined ? { narrationEnabled } : {}),
    ...(narrationObjectEnabled !== undefined
      ? { narration: { enabled: narrationObjectEnabled } }
      : {}),
    ...(assets ? { assets } : {}),
    ...(regeneration ? { regeneration } : {}),
  });
}
