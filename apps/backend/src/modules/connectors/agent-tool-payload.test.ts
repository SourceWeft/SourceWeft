import assert from "node:assert/strict";
import { test } from "vitest";
import { connectorActionApprovalPayload } from "./agent-tool-payload";

test("Gmail send approval shows the exact message without offering standing approval", () => {
  const body = "Private message body";
  const confirmation = connectorActionApprovalPayload({
    action: {
      id: "action-1",
      actionType: "gmail.message.send",
      agentToolName: "send_gmail_message",
      idempotencyKey: "once",
      requestJson: { __connectorEncryptedRequest: "ciphertext" },
      requestPreview: "Review the exact message",
      riskLevel: "high",
      status: "proposed",
    },
    connector: {
      id: "connector-1",
      name: "Gmail",
      connectorType: "gmail",
    } as never,
    allowStandingApproval: false,
    previewRequestJson: {
      from: "sender@example.com",
      to: ["recipient@example.com"],
      subject: "Hello",
      body,
    },
  });
  assert.equal(confirmation.preview.requestJson?.body, body);
  assert.equal(
    confirmation.decisionOptions.some(
      (option) => option.decision === "approve_always",
    ),
    false,
  );
  assert.equal(JSON.stringify(confirmation).includes("ciphertext"), false);
});
