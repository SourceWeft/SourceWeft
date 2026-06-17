import assert from "node:assert/strict";
import { test } from "vitest";
import { parseFinishLiveConfirmations } from "./chat-stream-confirmations";

function createConfirmation(overrides: Record<string, unknown> = {}) {
  return {
    type: "tool_confirmation_request",
    schemaVersion: 1,
    id: "confirmation-1",
    domain: "connector",
    subject: {
      label: "Notion",
      provider: "notion",
      connectorId: "connector-1",
    },
    action: {
      type: "create_page",
      toolName: "notion.pages.create",
      label: "Create Notion page",
      riskLevel: "medium",
      status: "proposed",
      requiresApproval: true,
    },
    preview: {
      title: "Create page",
      requestJson: { title: "Demo" },
    },
    decisionOptions: [
      { decision: "approve", label: "Approve" },
      { decision: "reject", label: "Reject" },
    ],
    execution: {
      providerStatus: "not_executed",
      executor: {
        kind: "connector_action_run",
        connectorId: "connector-1",
        actionRunId: "confirmation-1",
      },
    },
    status: "proposed",
    userMessage: "Create the Notion page?",
    ...overrides,
  };
}

test("finish live confirmations parser accepts explicit finish payload", () => {
  const confirmation = createConfirmation();

  const parsed = parseFinishLiveConfirmations([
    {
      confirmation,
      toolCall: {
        id: "tool-call-1",
        tool: "notion.pages.create",
        input: { title: "Demo" },
        output: confirmation,
        latencyMs: 0,
        status: "approval_requested",
        error: null,
        sequence: 2,
        approvalConfirmationId: "confirmation-1",
      },
    },
  ]);

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.confirmation.id, "confirmation-1");
  assert.equal(parsed[0]?.toolCall.id, "tool-call-1");
  assert.equal(parsed[0]?.toolCall.status, "approval_requested");
});

test("finish live confirmations parser accepts sandbox confirmation payloads", () => {
  const confirmation = {
    type: "tool_confirmation_request",
    schemaVersion: 1,
    id: "call_b8c9d4c6b83542c58f55754e",
    domain: "sandbox",
    subject: {
      label: "Sandbox runtime",
      provider: "sandbox",
    },
    action: {
      type: "execute",
      toolName: "execute",
      label: "execute",
      description:
        "Execute a shell command inside an isolated sandbox runtime.",
      riskLevel: "high",
      status: "proposed",
      requiresApproval: true,
    },
    preview: {
      title: "Review sandbox action: execute",
      requestJson: {
        command: 'python3 -c "print(1+1+76557890876)"',
      },
    },
    editableArgs: {
      value: {
        command: 'python3 -c "print(1+1+76557890876)"',
      },
    },
    decisionOptions: [
      { decision: "reject", label: "Reject" },
      { decision: "approve", label: "Approve" },
    ],
    execution: {
      providerStatus: "not_executed",
      executor: {
        kind: "sandbox_tool_call",
      },
      sourceweft: {
        hitlInterruptId: "3edbacaa7a97a7350c2285a67a59cbb9",
        sandboxExecuteToolCallId: "call_b8c9d4c6b83542c58f55754e",
      },
    },
    status: "proposed",
    userMessage: "Waiting for sandbox action confirmation.",
  };

  const parsed = parseFinishLiveConfirmations([
    {
      confirmation,
      toolCall: {
        id: "call_b8c9d4c6b83542c58f55754e",
        tool: "execute",
        input: {
          command: 'python3 -c "print(1+1+76557890876)"',
        },
        output: confirmation,
        latencyMs: 0,
        status: "approval_requested",
        error: null,
        sequence: 2,
      },
    },
  ]);

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.confirmation.domain, "sandbox");
  assert.equal(parsed[0]?.toolCall.tool, "execute");
});

test("finish live confirmations parser fails when finish payload is missing", () => {
  assert.throws(
    () => parseFinishLiveConfirmations(undefined),
    /missing confirmation payload/,
  );
  assert.throws(
    () => parseFinishLiveConfirmations([]),
    /missing confirmation payload/,
  );
});

test("finish live confirmations parser rejects invalid or non-pending payload", () => {
  const confirmation = createConfirmation();

  assert.throws(
    () =>
      parseFinishLiveConfirmations([
        {
          confirmation: createConfirmation({ status: "approved" }),
          toolCall: {
            id: "tool-call-1",
            tool: "notion.pages.create",
            input: { title: "Demo" },
            output: confirmation,
            latencyMs: 0,
            status: "approval_requested",
            error: null,
          },
        },
      ]),
    /invalid payload/,
  );

  assert.throws(
    () =>
      parseFinishLiveConfirmations([
        {
          confirmation,
          toolCall: {
            id: "tool-call-1",
            tool: "notion.pages.create",
            input: null,
            output: confirmation,
            latencyMs: 0,
            status: "approval_requested",
            error: null,
          },
        },
      ]),
    /invalid payload/,
  );
});
