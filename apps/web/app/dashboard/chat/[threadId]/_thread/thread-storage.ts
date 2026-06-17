import type { ModelItem, ModelType } from "../../_components/model-catalog-utils";
import type { PromptThinkingSettings } from "../../_components/chat-canvas";
import type { ThreadChatPreferences } from "@sourceweft/contracts";

const EMPTY_MODEL_KIND_FLAGS: Record<ModelType, boolean> = {
  llm: false,
  image: false,
  vision: false,
};

const DEFAULT_THINKING_SETTINGS: PromptThinkingSettings = {
  mode: "auto",
  effort: "medium",
};

function mapChatPreferencesToThinkingSettings(
  preferences: ThreadChatPreferences,
): PromptThinkingSettings {
  return {
    mode: preferences.thinking.mode,
    effort: preferences.thinking.effort,
  };
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
  DEFAULT_THINKING_SETTINGS,
  mapChatPreferencesToThinkingSettings,
  normalizeThinkingSettingsForModel,
};
