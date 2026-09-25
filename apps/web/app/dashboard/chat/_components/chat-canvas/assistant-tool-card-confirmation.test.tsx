import assert from "node:assert/strict";
import { createElement, type ComponentProps, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "vitest";
import { NextIntlClientProvider } from "next-intl";
import { AssistantToolCard } from "./assistant-tool-card";
import {
  isToolStatusUnexecuted,
  resolveConfirmationStatusKey,
} from "./assistant-tool-card-state";
import type { ToolCallRecord, ToolConfirmationResolution } from "./types";
import messages from "../../../../../messages/en.json";

const intlMessages = messages as ComponentProps<
  typeof NextIntlClientProvider
>["messages"];
const withIntl = (node: ReactNode) => (
  <NextIntlClientProvider locale="en" messages={intlMessages}>
    {node}
  </NextIntlClientProvider>
);

const sendCall: ToolCallRecord = {
  id: "send-1",
  tool: "send_gmail_message",
  input: { to: "someone@example.com" },
  latencyMs: 1,
  status: "approval_requested",
  error: null,
  output: {
    type: "tool_confirmation_request",
    schemaVersion: 1,
    id: "approval-1",
    domain: "connector",
    subject: { label: "Gmail", provider: "gmail", connectorId: "c-1" },
    action: {
      type: "send",
      toolName: "send_gmail_message",
      label: "Send",
      riskLevel: "high",
      status: "proposed",
      requiresApproval: true,
    },
    preview: { title: "Send email" },
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

function renderCard(resolution?: ToolConfirmationResolution) {
  return renderToStaticMarkup(
    withIntl(
      createElement(AssistantToolCard, {
        defaultOpen: true,
        resolvedConfirmations: resolution ? [resolution] : [],
        toolCall: sendCall,
      }),
    ),
  );
}

test("pending approval keeps the waiting state", () => {
  const html = renderCard();
  assert.ok(html.includes("Needs approval"));
  assert.ok(!html.includes("Not run"));
});

for (const flag of ["expired", "stale", "stopped"] as const) {
  test(`${flag} approval reads as not run, without a duration`, () => {
    const html = renderCard({
      confirmationId: "approval-1",
      decision: "reject",
      [flag]: true,
    });
    assert.ok(html.includes("Not run"));
    assert.ok(!html.includes("Needs approval"));
    assert.ok(!html.includes("1ms"));
    assert.ok(!html.includes("time:"));
  });
}

test("rejected approval reads as rejected, without a duration", () => {
  const html = renderCard({ confirmationId: "approval-1", decision: "reject" });
  assert.ok(html.includes("Rejected"));
  assert.ok(!html.includes("Needs approval"));
  assert.ok(!html.includes("1ms"));
});

test("confirmation resolution outranks the stale tool call status", () => {
  const cases: Array<[ToolConfirmationResolution | null, string | null]> = [
    [null, null],
    [{ confirmationId: "a", decision: "reject", expired: true }, "not-run"],
    [{ confirmationId: "a", decision: "reject", stale: true }, "not-run"],
    [{ confirmationId: "a", decision: "approve", stopped: true }, "not-run"],
    [{ confirmationId: "a", decision: "reject" }, "rejected"],
    [{ confirmationId: "a", decision: "approve" }, "running"],
  ];
  for (const [confirmationResolution, expected] of cases) {
    assert.equal(
      resolveConfirmationStatusKey({
        confirmationResolution,
        toolCallStatus: "approval_requested",
      }),
      expected,
    );
  }
  assert.equal(
    resolveConfirmationStatusKey({
      confirmationResolution: { confirmationId: "a", decision: "approve" },
      toolCallStatus: "completed",
    }),
    null,
  );
});

test("only executed statuses report a duration", () => {
  assert.equal(isToolStatusUnexecuted("needs-approval"), true);
  assert.equal(isToolStatusUnexecuted("not-run"), true);
  assert.equal(isToolStatusUnexecuted("rejected"), true);
  assert.equal(isToolStatusUnexecuted("done"), false);
  assert.equal(isToolStatusUnexecuted("failed"), false);
  assert.equal(isToolStatusUnexecuted("running"), false);
});
