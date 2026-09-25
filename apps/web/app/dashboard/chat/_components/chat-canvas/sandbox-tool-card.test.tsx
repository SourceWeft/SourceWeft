import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "vitest";
import { SandboxToolCard } from "./sandbox-tool-card";
import type { ToolCallRecord, ToolConfirmationResolution } from "./types";
import { withIntl } from "@/test/react";

const toolCall: ToolCallRecord = {
  id: "execute-1",
  tool: "execute",
  input: { command: "pwd" },
  latencyMs: 1,
  status: "approval_requested",
  error: null,
  output: {
    type: "tool_confirmation_request",
    schemaVersion: 1,
    id: "approval-1",
    domain: "connector",
    subject: { label: "Mac", provider: "provider", connectorId: "c-1" },
    action: {
      type: "execute",
      toolName: "execute",
      label: "Execute",
      riskLevel: "high",
      status: "proposed",
      requiresApproval: true,
    },
    preview: { title: "Run pwd" },
    decisionOptions: [
      { decision: "approve", label: "Approve" },
      { decision: "reject", label: "Reject" },
    ],
    execution: {
      providerStatus: "not_executed",
      executor: {
        kind: "connector_action_run",
        connectorId: "c-1",
        actionRunId: "r-1",
      },
    },
    status: "proposed",
    userMessage: "Waiting for confirmation.",
  },
};
test("pending approval still shows the waiting indicator", () => {
  const html = renderToStaticMarkup(
    withIntl(createElement(SandboxToolCard, { toolCall, defaultOpen: true })),
  );
  assert.ok(html.includes("Waiting for approval before execution."));
  assert.ok(html.includes("Needs approval"));
});
for (const [flag, label] of [
  ["stopped", "stopped"],
  ["expired", "expired"],
  ["reject", "rejected"],
  ["approve", "recorded"],
] as const) {
  test(`resolved ${flag} approval does not keep the stale waiting indicator`, () => {
    const resolution: ToolConfirmationResolution = {
      confirmationId: "approval-1",
      decision: flag === "approve" ? "approve" : "reject",
      ...(flag === "stopped"
        ? { stopped: true }
        : flag === "expired"
          ? { expired: true }
          : {}),
    };
    const html = renderToStaticMarkup(
      withIntl(
        createElement(SandboxToolCard, {
          toolCall,
          defaultOpen: true,
          resolvedConfirmations: [resolution],
        }),
      ),
    );
    assert.ok(html.includes(`approval ${label}`));
    assert.ok(!html.includes("Waiting for approval before execution."));
    assert.ok(!html.includes("Needs approval"));
    if (flag !== "approve") assert.ok(html.includes("The action was not run."));
  });
}

test("command cards use plain operation labels instead of implementation terminology", () => {
  const html = renderToStaticMarkup(
    withIntl(createElement(SandboxToolCard, { toolCall, defaultOpen: true })),
  );
  assert.ok(html.includes("Run command"));
  assert.ok(!html.includes("Execute sandbox command"));
  assert.ok(!html.includes("Sandbox command"));
  assert.ok(!html.includes("Recorded operations"));
});
