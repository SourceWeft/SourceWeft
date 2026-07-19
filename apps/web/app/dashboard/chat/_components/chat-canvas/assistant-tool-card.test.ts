import assert from "node:assert/strict";
import { test } from "vitest";
import { resolveAssistantToolCardDefaultOpen } from "./assistant-tool-card-state";

test("read_file previews do not override explicit collapsed default", () => {
  assert.equal(
    resolveAssistantToolCardDefaultOpen({
      defaultOpen: false,
      hasReadFilePreview: true,
      statusKey: "done",
    }),
    false,
  );
});

test("read_file previews auto-open when no explicit default is provided", () => {
  assert.equal(
    resolveAssistantToolCardDefaultOpen({
      hasReadFilePreview: true,
      statusKey: "done",
    }),
    true,
  );
});

test("failed tool cards auto-open by status", () => {
  assert.equal(
    resolveAssistantToolCardDefaultOpen({
      hasReadFilePreview: false,
      statusKey: "failed",
    }),
    true,
  );
});
