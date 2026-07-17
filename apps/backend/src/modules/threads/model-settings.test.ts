import assert from "node:assert/strict";
import { test, vi } from "vitest";

vi.mock("@sourceweft/db", () => ({
  db: {},
  modelGatewayProfiles: {},
}));

import {
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
