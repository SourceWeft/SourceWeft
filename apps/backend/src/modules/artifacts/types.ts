export type PublishArtifactToolSelection = {
  enabled?: boolean;
};

export type GenerateVideoPresentationToolSelection = {
  enabled?: boolean;
  language?: string;
  durationTarget?: "short" | "medium" | "long";
  stylePreset?: "cinematic" | "editorial" | "executive" | "technical" | "product";
  renderProfile?: {
    stylePreset?: "cinematic" | "editorial" | "executive" | "technical" | "product";
    visualDensity?: "light" | "balanced" | "dense";
    durationTarget?: "short" | "medium" | "long";
    language?: string;
  };
  slideCount?: number;
  visualDirection?: string;
  brand?: {
    colors?: string[];
    typography?: string;
    logoAssetId?: string;
  };
  motion?: {
    pacing?: "calm" | "dynamic" | "energetic";
    transitionStyle?: string;
    animationIntensity?: "subtle" | "balanced" | "bold";
  };
  canvas?: {
    width?: number;
    height?: number;
    fps?: number;
  };
  narration?: {
    enabled?: boolean;
  };
};

function normalizeOptionalBoolean(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function normalizeRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizeOptionalString(value: unknown, maxLength: number) {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim().slice(0, maxLength);
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeOptionalInteger(value: unknown, min: number, max: number) {
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

function normalizeStringArray(value: unknown, maxItems: number, maxLength: number) {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value
    .map((item) => normalizeOptionalString(item, maxLength))
    .filter((item): item is string => Boolean(item))
    .slice(0, maxItems);
  return items.length > 0 ? items : undefined;
}

function normalizeStylePreset(
  value: unknown,
): GenerateVideoPresentationToolSelection["stylePreset"] {
  return value === "cinematic" ||
    value === "editorial" ||
    value === "executive" ||
    value === "technical" ||
    value === "product"
    ? value
    : undefined;
}

function normalizeVisualDensity(
  value: unknown,
): NonNullable<
  GenerateVideoPresentationToolSelection["renderProfile"]
>["visualDensity"] {
  return value === "light" || value === "balanced" || value === "dense"
    ? value
    : undefined;
}

function normalizeDurationTarget(
  value: unknown,
): GenerateVideoPresentationToolSelection["durationTarget"] {
  return value === "short" || value === "medium" || value === "long"
    ? value
    : undefined;
}

function normalizeVideoBrand(
  value: unknown,
): GenerateVideoPresentationToolSelection["brand"] {
  const record = normalizeRecord(value);
  if (!record) {
    return undefined;
  }
  const colors = normalizeStringArray(record.colors, 8, 80);
  const typography = normalizeOptionalString(record.typography, 160);
  const logoAssetId = normalizeOptionalString(record.logoAssetId, 160);
  if (!colors && !typography && !logoAssetId) {
    return undefined;
  }
  return {
    ...(colors ? { colors } : {}),
    ...(typography ? { typography } : {}),
    ...(logoAssetId ? { logoAssetId } : {}),
  };
}

function normalizeVideoMotion(
  value: unknown,
): GenerateVideoPresentationToolSelection["motion"] {
  const record = normalizeRecord(value);
  if (!record) {
    return undefined;
  }
  const pacing =
    record.pacing === "calm" ||
    record.pacing === "dynamic" ||
    record.pacing === "energetic"
      ? record.pacing
      : undefined;
  const transitionStyle = normalizeOptionalString(record.transitionStyle, 160);
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

function normalizeVideoCanvas(
  value: unknown,
): GenerateVideoPresentationToolSelection["canvas"] {
  const record = normalizeRecord(value);
  if (!record) {
    return undefined;
  }
  const width = normalizeOptionalInteger(record.width, 640, 3840);
  const height = normalizeOptionalInteger(record.height, 360, 2160);
  const fps = normalizeOptionalInteger(record.fps, 12, 60);
  if (!width && !height && !fps) {
    return undefined;
  }
  return {
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
    ...(fps ? { fps } : {}),
  };
}

function normalizeVideoRenderProfile(
  value: unknown,
): GenerateVideoPresentationToolSelection["renderProfile"] {
  const record = normalizeRecord(value);
  if (!record) {
    return undefined;
  }
  const renderProfile = {
    stylePreset: normalizeStylePreset(record.stylePreset),
    visualDensity: normalizeVisualDensity(record.visualDensity),
    durationTarget: normalizeDurationTarget(record.durationTarget),
    language: normalizeOptionalString(record.language, 20),
  };
  return Object.values(renderProfile).some((item) => item !== undefined)
    ? renderProfile
    : undefined;
}

export function normalizeGenerateVideoPresentationToolSelection(
  input: unknown,
): GenerateVideoPresentationToolSelection | undefined {
  const record = normalizeRecord(input);
  if (!record) {
    return undefined;
  }

  const enabled = normalizeOptionalBoolean(record.enabled);
  const language = normalizeOptionalString(record.language, 20);
  const durationTarget = normalizeDurationTarget(record.durationTarget);
  const stylePreset = normalizeStylePreset(record.stylePreset);
  const renderProfile = normalizeVideoRenderProfile(record.renderProfile);
  const slideCount = normalizeOptionalInteger(record.slideCount, 1, 12);
  const visualDirection = normalizeOptionalString(record.visualDirection, 1000);
  const brand = normalizeVideoBrand(record.brand);
  const motion = normalizeVideoMotion(record.motion);
  const canvas = normalizeVideoCanvas(record.canvas);
  const narrationRecord = normalizeRecord(record.narration);
  const narrationEnabled = normalizeOptionalBoolean(narrationRecord?.enabled);
  const narration =
    narrationEnabled !== undefined ? { enabled: narrationEnabled } : undefined;

  if (
    enabled === undefined &&
    !language &&
    !durationTarget &&
    !stylePreset &&
    !renderProfile &&
    slideCount === undefined &&
    !visualDirection &&
    !brand &&
    !motion &&
    !canvas &&
    !narration
  ) {
    return undefined;
  }

  return {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(language ? { language } : {}),
    ...(durationTarget ? { durationTarget } : {}),
    ...(stylePreset ? { stylePreset } : {}),
    ...(renderProfile ? { renderProfile } : {}),
    ...(slideCount !== undefined ? { slideCount } : {}),
    ...(visualDirection ? { visualDirection } : {}),
    ...(brand ? { brand } : {}),
    ...(motion ? { motion } : {}),
    ...(canvas ? { canvas } : {}),
    ...(narration ? { narration } : {}),
  };
}
