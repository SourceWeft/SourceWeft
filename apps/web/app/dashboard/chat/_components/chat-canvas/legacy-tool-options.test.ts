import assert from "node:assert/strict";
import { test } from "vitest";
import {
  hasLegacyToolOptionsMetadata,
} from "./legacy-tool-options";

test("hasLegacyToolOptionsMetadata detects legacy tools without options", () => {
  assert.equal(
    hasLegacyToolOptionsMetadata({
      tools: { web_search: { enabled: true } },
    }),
    true,
  );
  assert.equal(
    hasLegacyToolOptionsMetadata({
      options: { version: 1, tools: { web_search: { enabled: true } } },
      tools: { web_search: { enabled: true } },
    }),
    false,
  );
  assert.equal(hasLegacyToolOptionsMetadata(undefined), false);
});
