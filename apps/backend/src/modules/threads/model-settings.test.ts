import assert from "node:assert/strict";
import { test, vi } from "vitest";

vi.mock("@sourceweft/db", () => ({
  db: {},
  modelGatewayProfiles: {},
}));

import {
  applyResolvedThreadModelSettings,
  mergeThreadModelSettings,
  normalizeThreadModelSettings,
} from "./model-settings";

test("normalizeThreadModelSettings treats default aliases as inherited defaults", () => {
  assert.deepEqual(
    normalizeThreadModelSettings({
      llmProfileAlias: "chat-default",
      llmModelAlias: "chat-default",
      imageProfileAlias: "image-default",
      imageModelAlias: "image-default",
      visionProfileAlias: "vision-default",
      visionModelAlias: "vision-default",
    }),
    {
      llmProfileAlias: null,
      llmModelAlias: null,
      imageProfileAlias: null,
      imageModelAlias: null,
      visionProfileAlias: null,
      visionModelAlias: null,
    },
  );
});

test("applyResolvedThreadModelSettings persists normalized image profile overrides", () => {
  const persisted = applyResolvedThreadModelSettings(
    normalizeThreadModelSettings({
      llmProfileAlias: null,
      llmModelAlias: null,
      imageProfileAlias: null,
      imageModelAlias: null,
      visionProfileAlias: null,
      visionModelAlias: null,
    }),
    {
      image: {
        profileAlias: "global-openrouter-image-model",
        modelAlias: "openrouter/image-model",
      },
    },
  );

  assert.deepEqual(persisted, {
    llmProfileAlias: null,
    llmModelAlias: null,
    imageProfileAlias: "global-openrouter-image-model",
    imageModelAlias: "openrouter/image-model",
    visionProfileAlias: null,
    visionModelAlias: null,
  });
});

test("applyResolvedThreadModelSettings normalizes default aliases to inherited defaults", () => {
  const persisted = applyResolvedThreadModelSettings(
    normalizeThreadModelSettings({
      llmProfileAlias: "global-openrouter-chat-model",
      llmModelAlias: "openrouter/chat-model",
      imageProfileAlias: "global-openrouter-image-model",
      imageModelAlias: "openrouter/image-model",
      visionProfileAlias: "global-openrouter-vision-model",
      visionModelAlias: "openrouter/vision-model",
    }),
    {
      image: {
        profileAlias: "image-default",
        modelAlias: "image-default",
      },
      vision: {
        profileAlias: "vision-default",
        modelAlias: "vision-default",
      },
    },
  );

  assert.deepEqual(persisted, {
    llmProfileAlias: "global-openrouter-chat-model",
    llmModelAlias: "openrouter/chat-model",
    imageProfileAlias: null,
    imageModelAlias: null,
    visionProfileAlias: null,
    visionModelAlias: null,
  });
});

test("mergeThreadModelSettings clears explicit selections when patched with default aliases", () => {
  assert.deepEqual(
    mergeThreadModelSettings(
      normalizeThreadModelSettings({
        llmProfileAlias: "global-openrouter-chat-model",
        llmModelAlias: "openrouter/chat-model",
        imageProfileAlias: "global-openrouter-image-model",
        imageModelAlias: "openrouter/image-model",
        visionProfileAlias: "global-openrouter-vision-model",
        visionModelAlias: "openrouter/vision-model",
      }),
      {
        llmProfileAlias: "chat-default",
        imageProfileAlias: "image-default",
        visionProfileAlias: "vision-default",
      },
    ),
    {
      llmProfileAlias: null,
      llmModelAlias: null,
      imageProfileAlias: null,
      imageModelAlias: null,
      visionProfileAlias: null,
      visionModelAlias: null,
    },
  );
});
