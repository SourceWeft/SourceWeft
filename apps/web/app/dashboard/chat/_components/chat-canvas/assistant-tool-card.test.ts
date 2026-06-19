import assert from "node:assert/strict";
import { test } from "vitest";
import { resolveAssistantToolCardDefaultOpen } from "./assistant-tool-card";

test("read_file previews do not override explicit collapsed default", () => {
  assert.equal(
    resolveAssistantToolCardDefaultOpen({
      defaultOpen: false,
      hasReadFilePreview: true,
      statusLabel: "Done",
    }),
    false,
  );
});

test("read_file previews auto-open when no explicit default is provided", () => {
  assert.equal(
    resolveAssistantToolCardDefaultOpen({
      hasReadFilePreview: true,
      statusLabel: "Done",
    }),
    true,
  );
});

test("failed tool cards auto-open by status", () => {
  assert.equal(
    resolveAssistantToolCardDefaultOpen({
      hasReadFilePreview: false,
      statusLabel: "Failed",
    }),
    true,
  );
});
