import { logger } from "../logger";

const OPENROUTER_MODELS_API_URL = "https://openrouter.ai/api/v1/models";
const DYNAMIC_OPENROUTER_PROFILE_PREFIX = "global-openrouter";
const OPENROUTER_APP_TITLE = "SourceWeft";
const OPENROUTER_APP_REFERER = "https://sourceweft.com";

export type DynamicOpenRouterProfileEntry = {
  displayName: string;
  profileAlias: string;
  targetModel: string;
};

export type DynamicOpenRouterProfilesByKind = {
  chat: DynamicOpenRouterProfileEntry[];
  image: DynamicOpenRouterProfileEntry[];
  vision: DynamicOpenRouterProfileEntry[];
};

function normalizeCatalogSlug(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized.length > 0 ? normalized : "model";
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
}

export async function fetchDynamicOpenRouterProfiles(): Promise<DynamicOpenRouterProfilesByKind> {
  const empty: DynamicOpenRouterProfilesByKind = {
    chat: [],
    image: [],
    vision: [],
  };

  try {
    const response = await fetch(OPENROUTER_MODELS_API_URL, {
      headers: {
        "User-Agent": "sourceweft-model-gateway/1.0",
        "X-Title": OPENROUTER_APP_TITLE,
        "HTTP-Referer": OPENROUTER_APP_REFERER,
      },
    });
    if (!response.ok) {
      logger.warn("Failed to load OpenRouter model catalog", {
        status: response.status,
      });
      return empty;
    }

    const payload = (await response.json()) as { data?: unknown };
    if (!payload?.data || !Array.isArray(payload.data)) {
      return empty;
    }

    const byKind: DynamicOpenRouterProfilesByKind = {
      chat: [],
      image: [],
      vision: [],
    };

    for (const rawModel of payload.data) {
      if (!rawModel || typeof rawModel !== "object") {
        continue;
      }

      const model = rawModel as Record<string, unknown>;
      const modelId = typeof model.id === "string" ? model.id.trim() : "";
      if (!modelId || !modelId.includes("/")) {
        continue;
      }

      const name = typeof model.name === "string" && model.name.trim().length > 0
        ? model.name.trim()
        : modelId;

      const architecture =
        model.architecture && typeof model.architecture === "object"
          ? (model.architecture as Record<string, unknown>)
          : {};
      const inputModalities = toStringArray(architecture.input_modalities);
      const outputModalities = toStringArray(architecture.output_modalities);

      const hasImageInput = inputModalities.includes("image");
      const hasTextOutput = outputModalities.includes("text");
      const hasImageOutput = outputModalities.includes("image");

      const slug = normalizeCatalogSlug(modelId);
      const encodedModelId = encodeURIComponent(modelId);
      const asEntry = (kind: "chat" | "image" | "vision") => ({
        displayName: name,
        // Keep profileAlias internal for sync identity, expose modelAlias as real model id.
        profileAlias: `${DYNAMIC_OPENROUTER_PROFILE_PREFIX}-${kind}-${slug}-${encodedModelId}`,
        targetModel: modelId,
      });

      if (hasImageOutput) {
        byKind.image.push(asEntry("image"));
      }

      if (hasImageInput && hasTextOutput && !hasImageOutput) {
        byKind.vision.push(asEntry("vision"));
      }

      if (hasTextOutput && !hasImageOutput) {
        byKind.chat.push(asEntry("chat"));
      }
    }

    const sorter = (
      left: DynamicOpenRouterProfileEntry,
      right: DynamicOpenRouterProfileEntry,
    ) => left.displayName.localeCompare(right.displayName);

    byKind.chat.sort(sorter);
    byKind.image.sort(sorter);
    byKind.vision.sort(sorter);

    return byKind;
  } catch (error) {
    logger.warn("Failed to fetch OpenRouter models", {
      error: error instanceof Error ? error.message : String(error),
    });
    return empty;
  }
}
