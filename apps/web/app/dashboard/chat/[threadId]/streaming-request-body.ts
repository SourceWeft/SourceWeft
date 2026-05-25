import {
  buildChatToolsRequest,
  type ChatSendInput,
  type PromptThinkingSettings,
} from "../_components/chat-canvas";
import type { ToolApprovalResume } from "@sourceweft/sdk";
import {
  type ModelItem,
  type ModelType,
  type SelectedModels,
} from "../_components/model-catalog-utils";
import {
  buildByokModelExecution,
  type ByokModelSelection,
} from "../_components/byok-state";

export type RequestThinkingConfig = {
  mode: "auto" | "off" | "effort";
  enabled?: boolean;
  effort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  includeReasoning?: boolean;
};

type BuildStreamingRequestBodyInput = {
  byokSelections?: Partial<Record<ModelType, ByokModelSelection | null>>;
  catalogKindEnabled: Partial<Record<ModelType, boolean>>;
  command?: ChatSendInput["command"];
  durableRunKey: string;
  images?: ChatSendInput["images"];
  mentionedSourceIds?: string[];
  mode: "send" | "refresh" | "edit" | "resume";
  selectedByokModels: Partial<Record<ModelType, ByokModelSelection | null>>;
  selectedModels: SelectedModels;
  searchEnabled: boolean;
  sourceIds?: string[];
  skillIds?: string[];
  streamWithSelectedLlm: boolean;
  thinking?: RequestThinkingConfig;
  thinkingSettings: PromptThinkingSettings;
  timezone?: string;
  tools?: ChatSendInput["tools"];
  userMessageId?: string | null;
  assistantMessageId?: string | null;
  attachOnly?: boolean;
  content?: string;
  toolApprovalResume?: ToolApprovalResume | null;
};

export function buildRequestThinking(input: {
  capabilities: ModelItem["capabilities"] | undefined;
  settings: PromptThinkingSettings;
}): RequestThinkingConfig | undefined {
  if (input.capabilities?.supportsThinking !== true) {
    return undefined;
  }

  if (input.settings.mode === "off") {
    return {
      mode: "off",
      enabled: false,
      includeReasoning: false,
    };
  }

  if (input.settings.mode === "effort") {
    if (
      !(input.capabilities?.supportedEfforts ?? []).includes(
        input.settings.effort,
      )
    ) {
      return {
        mode: "auto",
      };
    }

    return {
      mode: "effort",
      enabled: true,
      effort: input.settings.effort,
      includeReasoning: true,
    };
  }

  return {
    mode: "auto",
  };
}

export function buildStreamingThreadRequestBody(
  input: BuildStreamingRequestBodyInput,
) {
  const requestBody: Record<string, unknown> = {
    mode: input.mode,
    ...(input.mentionedSourceIds && input.mentionedSourceIds.length > 0
      ? { mentionedSourceIds: input.mentionedSourceIds }
      : {}),
    ...(input.sourceIds ? { sourceIds: input.sourceIds } : {}),
    timezone: input.timezone,
    idempotencyKey: input.durableRunKey,
  };

  if (input.command) {
    requestBody.command = input.command;
  }

  const selectedSkillIds = input.skillIds ?? [];
  const effectiveByokSelections =
    input.byokSelections ?? input.selectedByokModels;

  requestBody.tools = buildChatToolsRequest({
    imageExecution:
      effectiveByokSelections.image?.mode === "byok"
        ? buildByokModelExecution({
            selection: effectiveByokSelections.image,
          })
        : null,
    invokedSkillIds: input.tools?.invokedSkillIds,
    skillIds: selectedSkillIds,
    searchEnabled: input.searchEnabled,
    tools: input.tools,
  });

  const selectedLlmProfileAlias =
    input.streamWithSelectedLlm && input.catalogKindEnabled.llm
      ? input.selectedModels.llm?.profileAlias ?? input.selectedModels.llm?.id
      : undefined;
  const requestThinking =
    input.thinking ??
    buildRequestThinking({
      capabilities: input.selectedModels.llm?.capabilities,
      settings: input.thinkingSettings,
    });
  const byokLlmRequest = buildByokModelExecution({
    selection: effectiveByokSelections.llm,
    thinking: requestThinking,
  });
  if (effectiveByokSelections.llm?.mode === "byok") {
    requestBody.llm = byokLlmRequest;
  } else if (
    typeof selectedLlmProfileAlias === "string" &&
    selectedLlmProfileAlias.length > 0
  ) {
    requestBody.llm = {
      profileAlias: selectedLlmProfileAlias,
      ...(requestThinking ? { thinking: requestThinking } : {}),
    };
  } else if (requestThinking) {
    requestBody.llm = {
      thinking: requestThinking,
    };
  }

  if (!input.attachOnly && (input.mode === "send" || input.mode === "edit")) {
    requestBody.content = input.content ?? "";
    if (input.mode === "edit" || (input.images && input.images.length > 0)) {
      requestBody.images = input.images;
    }
  }

  const modelSettings: Record<string, string> = {};
  const byokVisionRequest = buildByokModelExecution({
    selection: effectiveByokSelections.vision,
  });
  if (effectiveByokSelections.vision?.mode === "byok") {
    requestBody.vision = byokVisionRequest;
  } else if (input.catalogKindEnabled.vision && input.selectedModels.vision) {
    modelSettings.visionProfileAlias =
      input.selectedModels.vision.profileAlias ?? input.selectedModels.vision.id;
  }
  if (effectiveByokSelections.image?.mode === "byok") {
    requestBody.image = buildByokModelExecution({
      selection: effectiveByokSelections.image,
    });
  } else if (
    input.catalogKindEnabled.image &&
    input.selectedModels.image?.profileAlias
  ) {
    modelSettings.imageProfileAlias = input.selectedModels.image.profileAlias;
  }
  if (Object.keys(modelSettings).length > 0) {
    requestBody.modelSettings = modelSettings;
  }

  if (
    input.mode === "refresh" ||
    input.mode === "edit" ||
    input.mode === "resume"
  ) {
    if (input.userMessageId) {
      requestBody.userMessageId = input.userMessageId;
    }
    if (input.assistantMessageId) {
      requestBody.assistantMessageId = input.assistantMessageId;
    }
  }

  if (input.toolApprovalResume && input.mode !== "resume") {
    throw new Error("toolApprovalResume requires resume mode.");
  }

  if (input.toolApprovalResume) {
    requestBody.toolApprovalResume = input.toolApprovalResume;
  }

  return requestBody;
}
