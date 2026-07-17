import assert from "node:assert/strict";
import { test, vi } from "vitest";

vi.mock("@sourceweft/db", () => ({
  db: {},
  modelGatewayProfiles: {},
}));

import {
  applyResolvedThreadModelSettings,
  normalizeThreadModelSettings,
} from "../model-settings";

test("preparer persistence uses normalized image profile overrides instead of stale thread settings", () => {
  const persistedThreadSettingsWithSnapshots = normalizeThreadModelSettings({
    llmProfileAlias: null,
    llmModelAlias: null,
    imageProfileAlias: null,
    imageModelAlias: null,
    visionProfileAlias: null,
    visionModelAlias: null,
  });
  const normalizedThreadSettings = normalizeThreadModelSettings({
    ...persistedThreadSettingsWithSnapshots,
    imageProfileAlias: "global-openrouter-image-model",
    imageModelAlias: "openrouter/image-model",
  });
  const normalizedThreadSettingsWithSnapshots = {
    ...normalizedThreadSettings,
    imageProfileSnapshot: { alias: "global-openrouter-image-model" },
  };

  const persistedResolvedThreadSettings = applyResolvedThreadModelSettings(
    normalizedThreadSettingsWithSnapshots,
    {
      image: {
        profileAlias: normalizedThreadSettings.imageProfileAlias,
        modelAlias: normalizedThreadSettings.imageModelAlias,
      },
    },
  );

  assert.notDeepEqual(
    persistedResolvedThreadSettings.imageProfileAlias,
    persistedThreadSettingsWithSnapshots.imageProfileAlias,
  );
  assert.equal(
    persistedResolvedThreadSettings.imageProfileAlias,
    "global-openrouter-image-model",
  );
  assert.equal(
    persistedResolvedThreadSettings.imageModelAlias,
    "openrouter/image-model",
  );
});

test("preparer persistence does not write BYOK default aliases back to thread settings", () => {
  const persistedResolvedThreadSettings = applyResolvedThreadModelSettings(
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
    },
  );

  assert.equal(persistedResolvedThreadSettings.imageProfileAlias, null);
  assert.equal(persistedResolvedThreadSettings.imageModelAlias, null);
});
