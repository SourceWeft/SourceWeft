import assert from "node:assert/strict";
import { test } from "vitest";
import { formatChatErrorMessage } from "./chat-error-notice";

test("structured-output diagnostics are reduced to user-facing copy", () => {
  assert.equal(
    formatChatErrorMessage(
      "MODEL_STRUCTURED_OUTPUT_INVALID: Provider returned invalid structured output (length=0, sha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855)",
      "MODEL_STRUCTURED_OUTPUT_INVALID",
    ),
    "The model did not return valid structured content",
  );
});
