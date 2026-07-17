import assert from "node:assert/strict";
import { test, vi } from "vitest";
import type {
  ModelItem,
  SelectedModels,
} from "../_components/model-catalog-utils";
import { buildStreamingThreadRequestBody } from "./streaming-request-body";

vi.mock("../_components/chat-canvas", () => ({
  buildChatToolsRequest: () => ({}),
}));

const selectedModels: SelectedModels = {
  image: null,
  llm: null,
  vision: null,
};

function modelItem(overrides: Partial<ModelItem>): ModelItem {
  return {
    chef: "Global models",
    chefSlug: "sourceweft",
    id: "image-default",
    profileAlias: "image-default",
    modelAlias: "image-default",
    name: "Auto (Default)",
    provider: "sourceweft",
    subtitle: "Global models",
    ...overrides,
  };
}

const thinkingSettings = {
  effort: "medium" as const,
  includeReasoning: true,
  mode: "auto" as const,
};

test("edit request body includes selected user and assistant message ids", () => {
  const body = buildStreamingThreadRequestBody({
    catalogKindEnabled: {},
    content: "Edited prompt",
    durableRunKey: "sourceweft-web-run:edit-1",
    mode: "edit",
    searchEnabled: false,
    selectedByokModels: {},
    selectedModels,
    streamWithSelectedLlm: false,
    thinkingSettings,
    userMessageId: "user-version-2",
    assistantMessageId: "assistant-version-2",
  });

  assert.equal(body.mode, "edit");
  assert.equal(body.content, "Edited prompt");
  assert.equal(body.userMessageId, "user-version-2");
  assert.equal(body.assistantMessageId, "assistant-version-2");
});

test("resume request body carries assistant id and DeepAgents resume payload without content", () => {
  const toolApprovalResume = {
    decisions: [{ type: "approve" as const }],
  };
  const body = buildStreamingThreadRequestBody({
    attachOnly: true,
    catalogKindEnabled: {},
    content: "Should not be resent",
    durableRunKey: "sourceweft-web-run:resume-1",
    mode: "resume",
    searchEnabled: false,
    selectedByokModels: {},
    selectedModels,
    streamWithSelectedLlm: false,
    thinkingSettings,
    assistantMessageId: "assistant-with-interrupt",
    toolApprovalResume,
  });

  assert.equal(body.mode, "resume");
  assert.equal(body.assistantMessageId, "assistant-with-interrupt");
  assert.equal(body.content, undefined);
  assert.equal(body.toolApprovalResume, toolApprovalResume);
});

test("non-resume request body rejects DeepAgents resume payloads", () => {
  assert.throws(
    () =>
      buildStreamingThreadRequestBody({
        catalogKindEnabled: {},
        durableRunKey: "sourceweft-web-run:refresh-1",
        mode: "refresh",
        searchEnabled: false,
        selectedByokModels: {},
        selectedModels,
        streamWithSelectedLlm: false,
        thinkingSettings,
        assistantMessageId: "assistant-with-interrupt",
        toolApprovalResume: {
          decisions: [{ type: "approve" }],
        },
      }),
    /toolApprovalResume requires resume mode/,
  );
});

test("request body omits default image and vision profile aliases", () => {
  const body = buildStreamingThreadRequestBody({
    catalogKindEnabled: { image: true, vision: true },
    content: "Generate an image",
    durableRunKey: "sourceweft-web-run:default-models",
    mode: "send",
    searchEnabled: false,
    selectedByokModels: {},
    selectedModels: {
      image: modelItem({
        id: "image-default",
        profileAlias: "image-default",
        modelAlias: "image-default",
      }),
      llm: null,
      vision: modelItem({
        id: "vision-default",
        profileAlias: "vision-default",
        modelAlias: "vision-default",
      }),
    },
    streamWithSelectedLlm: false,
    thinkingSettings,
  });

  assert.equal(body.modelSettings, undefined);
  assert.equal(body.image, undefined);
  assert.equal(body.vision, undefined);
});

test("request body omits default llm profile alias", () => {
  const body = buildStreamingThreadRequestBody({
    catalogKindEnabled: { llm: true },
    content: "Hello",
    durableRunKey: "sourceweft-web-run:default-llm",
    mode: "send",
    searchEnabled: false,
    selectedByokModels: {},
    selectedModels: {
      image: null,
      llm: modelItem({
        id: "chat-default",
        profileAlias: "chat-default",
        modelAlias: "chat-default",
      }),
      vision: null,
    },
    streamWithSelectedLlm: true,
    thinkingSettings,
  });

  assert.equal(body.llm, undefined);
});

test("request body includes explicit non-default image execution profile", () => {
  const body = buildStreamingThreadRequestBody({
    catalogKindEnabled: { image: true },
    content: "Generate an image",
    durableRunKey: "sourceweft-web-run:explicit-image",
    mode: "send",
    searchEnabled: false,
    selectedByokModels: {},
    selectedModels: {
      image: modelItem({
        id: "global-openrouter-image-model",
        profileAlias: "global-openrouter-image-model",
        modelAlias: "openrouter/image-model",
      }),
      llm: null,
      vision: null,
    },
    streamWithSelectedLlm: false,
    thinkingSettings,
  });

  assert.equal(body.modelSettings, undefined);
  assert.deepEqual(body.image, {
    profileAlias: "global-openrouter-image-model",
  });
});

test("request body includes explicit non-default vision execution profile", () => {
  const body = buildStreamingThreadRequestBody({
    catalogKindEnabled: { vision: true },
    content: "Describe this image",
    durableRunKey: "sourceweft-web-run:explicit-vision",
    mode: "send",
    searchEnabled: false,
    selectedByokModels: {},
    selectedModels: {
      image: null,
      llm: null,
      vision: modelItem({
        id: "global-openrouter-vision-model",
        profileAlias: "global-openrouter-vision-model",
        modelAlias: "openrouter/vision-model",
      }),
    },
    streamWithSelectedLlm: false,
    thinkingSettings,
  });

  assert.equal(body.modelSettings, undefined);
  assert.deepEqual(body.vision, {
    profileAlias: "global-openrouter-vision-model",
  });
});

test("request body keeps image and vision BYOK execution separate from global profile aliases", () => {
  const body = buildStreamingThreadRequestBody({
    catalogKindEnabled: { image: true, vision: true },
    content: "Generate and inspect an image",
    durableRunKey: "sourceweft-web-run:byok-image-vision",
    mode: "send",
    searchEnabled: false,
    selectedByokModels: {
      image: {
        mode: "byok",
        byokModelId: "byok-image-model",
        modelAlias: "provider-image-model",
        providerName: "openai-compatible",
        source: "catalog",
      },
      vision: {
        mode: "byok",
        byokModelId: "byok-vision-model",
        modelAlias: "provider-vision-model",
        providerName: "openai-compatible",
        source: "catalog",
      },
    },
    selectedModels: {
      image: modelItem({
        id: "global-openrouter-image-model",
        profileAlias: "global-openrouter-image-model",
        modelAlias: "openrouter/image-model",
      }),
      llm: null,
      vision: modelItem({
        id: "global-openrouter-vision-model",
        profileAlias: "global-openrouter-vision-model",
        modelAlias: "openrouter/vision-model",
      }),
    },
    streamWithSelectedLlm: false,
    thinkingSettings,
  });

  assert.equal(body.modelSettings, undefined);
  assert.deepEqual(body.image, {
    executionMode: "BYOK",
    byokModelId: "byok-image-model",
    providerHint: "openai-compatible",
    modelAlias: "provider-image-model",
    providerModel: "provider-image-model",
  });
  assert.deepEqual(body.vision, {
    executionMode: "BYOK",
    byokModelId: "byok-vision-model",
    providerHint: "openai-compatible",
    modelAlias: "provider-vision-model",
    providerModel: "provider-vision-model",
  });
});
