import type { ModelItem, ModelType } from "../../_components/model-catalog-utils";
import type { PromptThinkingSettings } from "../../_components/chat-canvas";

const EMPTY_MODEL_KIND_FLAGS: Record<ModelType, boolean> = {
  llm: false,
  image: false,
  vision: false,
};

const SEARCH_PREFERENCE_STORAGE_VERSION = "v2";

function getSearchPreferenceStorageKey(workspaceId: string) {
  return `chat:search:${SEARCH_PREFERENCE_STORAGE_VERSION}:${workspaceId}:current`;
}

function parseStoredThinkingSettings(
  value: string | null,
): PromptThinkingSettings | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as Partial<PromptThinkingSettings>;
    const mode = parsed.mode;
    const effort = parsed.effort;
    if (mode !== "auto" && mode !== "off" && mode !== "effort") {
      return null;
    }
    if (
      effort !== "minimal" &&
      effort !== "low" &&
      effort !== "medium" &&
      effort !== "high" &&
      effort !== "xhigh"
    ) {
      return null;
    }
    return { mode, effort };
  } catch {
    return null;
  }
}

function normalizeThinkingSettingsForModel(input: {
  capabilities: ModelItem["capabilities"] | undefined;
  hasSavedPreference?: boolean;
  settings: PromptThinkingSettings;
}): PromptThinkingSettings {
  if (
    input.capabilities?.supportsThinking === true &&
    input.settings.mode === "off" &&
    input.hasSavedPreference !== true
  ) {
    return {
      ...input.settings,
      mode: "auto",
    };
  }

  if (input.settings.mode !== "effort") {
    return input.settings;
  }

  if (
    (input.capabilities?.supportedEfforts ?? []).includes(input.settings.effort)
  ) {
    return input.settings;
  }

  return {
    ...input.settings,
    mode: "auto",
  };
}

export {
  EMPTY_MODEL_KIND_FLAGS,
  getSearchPreferenceStorageKey,
  normalizeThinkingSettingsForModel,
  parseStoredThinkingSettings,
};
