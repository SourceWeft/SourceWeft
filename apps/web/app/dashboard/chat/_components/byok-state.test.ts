import assert from "node:assert/strict";
import { test } from "vitest";
import { buildThreadCreateModelSettings } from "./byok-state";

test("buildThreadCreateModelSettings omits default profile aliases", () => {
  assert.equal(
    buildThreadCreateModelSettings({
      globalProfileAlias: "chat-default",
      imageProfileAlias: "image-default",
      visionProfileAlias: "vision-default",
    }),
    undefined,
  );
});

test("buildThreadCreateModelSettings persists explicit non-default aliases", () => {
  assert.deepEqual(
    buildThreadCreateModelSettings({
      globalProfileAlias: "global-openrouter-chat-model",
      imageProfileAlias: "global-openrouter-image-model",
      visionProfileAlias: "global-openrouter-vision-model",
    }),
    {
      llmProfileAlias: "global-openrouter-chat-model",
      imageProfileAlias: "global-openrouter-image-model",
      visionProfileAlias: "global-openrouter-vision-model",
    },
  );
});
