import assert from "node:assert/strict";
import { test } from "vitest";
import { normalizePublicToolConfirmationOutput } from "./message-normalizers";

test("Gmail send confirmation keeps only the fields needed for exact review", () => {
  const normalized = normalizePublicToolConfirmationOutput({
    action: { type: "gmail.message.send" },
    preview: {
      requestJson: {
        from: "sender@example.com",
        to: ["recipient@example.com"],
        subject: "Subject",
        body: "Full private body",
        __connectorEncryptedRequest: "secret",
      },
    },
    editableArgs: { value: { secret: "secret" } },
  });
  assert.deepEqual(normalized.preview, {
    requestJson: {
      from: "sender@example.com",
      to: ["recipient@example.com"],
      subject: "Subject",
      body: "Full private body",
    },
  });
  assert.equal("editableArgs" in normalized, false);
});

test("Other connector confirmations still hide request arguments", () => {
  const normalized = normalizePublicToolConfirmationOutput({
    action: { type: "notion.page.create" },
    preview: { requestJson: { body: "Private" } },
  });
  assert.deepEqual(normalized.preview, {});
});
