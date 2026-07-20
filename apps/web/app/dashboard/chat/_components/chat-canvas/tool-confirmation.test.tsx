// @vitest-environment jsdom

import assert from "node:assert/strict";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, test, vi } from "vitest";

const respondToConfirmation = vi.fn();

vi.mock("../../../../../lib/sdk", () => ({
  connectorsClient: {
    respondToConfirmation: (...args: unknown[]) =>
      respondToConfirmation(...args),
  },
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { ToolInterventionBar } from "./tool-confirmation";
import type { ToolConfirmationItem } from "./tool-confirmation-state";

type Item = ToolConfirmationItem;

function createItem(input: {
  decisionOptions: Array<{ decision: string; label: string }>;
}): Item {
  return {
    assistantMessageId: "assistant-1",
    messageId: "assistant-1",
    threadRunId: "run-1",
    toolCall: {
      id: "tool-1",
      tool: "some_tool",
      input: {},
      output: null,
      latencyMs: 0,
      status: "approval_requested",
      error: null,
    },
    confirmation: {
      type: "tool_confirmation_request",
      schemaVersion: 1,
      id: "confirmation-1",
      domain: "connector",
      subject: { label: "Subject", provider: "provider", connectorId: "c-1" },
      action: {
        type: "provider.thing.delete",
        toolName: "some_tool",
        label: "Delete",
        riskLevel: "high",
        status: "proposed",
        requiresApproval: true,
      },
      preview: { title: "Delete a thing" },
      decisionOptions: input.decisionOptions,
      execution: {
        providerStatus: "not_executed",
        executor: {
          kind: "connector_action_run",
          connectorId: "c-1",
          actionRunId: "run-1",
        },
      },
      status: "proposed",
      userMessage: "Waiting for confirmation.",
    },
  } as unknown as Item;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function render(item: Item) {
  container = document.createElement("div");
  document.body.append(container);
  const createdRoot = createRoot(container);
  root = createdRoot;
  await act(async () => {
    createdRoot.render(
      createElement(ToolInterventionBar, {
        items: [item],
        workspaceId: "workspace-1",
      }),
    );
  });
  return container;
}

function buttonLabels(element: HTMLElement) {
  return [...element.querySelectorAll("button")].map((button) =>
    (button.textContent ?? "").trim(),
  );
}

function clickButton(element: HTMLElement, label: string) {
  const button = [...element.querySelectorAll("button")].find(
    (candidate) => (candidate.textContent ?? "").trim() === label,
  );
  assert.ok(button, `expected a "${label}" button`);
  return button;
}

beforeEach(() => {
  respondToConfirmation.mockReset();
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

test("the Always allow button is absent unless decisionOptions offers it", async () => {
  const element = await render(
    createItem({
      decisionOptions: [
        { decision: "reject", label: "Reject" },
        { decision: "approve", label: "Approve" },
      ],
    }),
  );
  assert.deepEqual(buttonLabels(element).includes("Always allow"), false);
  assert.equal(element.querySelector("select"), null);
});

test("the Always allow button and its duration select appear when offered", async () => {
  const element = await render(
    createItem({
      decisionOptions: [
        { decision: "reject", label: "Reject" },
        { decision: "approve", label: "Approve" },
        { decision: "approve_always", label: "Always allow" },
      ],
    }),
  );
  assert.ok(buttonLabels(element).includes("Always allow"));
  assert.ok(element.querySelector("select"));
});

test("a response without a trustRule never claims the approval was remembered", async () => {
  respondToConfirmation.mockResolvedValue({
    confirmation: { status: "approved" },
    resume: { decisions: [{ type: "approve" }] },
  });
  const element = await render(
    createItem({
      decisionOptions: [
        { decision: "reject", label: "Reject" },
        { decision: "approve", label: "Approve" },
        { decision: "approve_always", label: "Always allow" },
      ],
    }),
  );
  const button = clickButton(element, "Always allow");
  await act(async () => {
    button.click();
  });

  const [, , payload] = respondToConfirmation.mock.calls[0] as [
    string,
    string,
    { decision: string; trust?: Record<string, unknown> },
  ];
  assert.equal(payload.decision, "approve_always");
  // Granularity is never requested: `scope: "target"` is unreachable today and
  // would silently degrade to a wider tool-level grant.
  assert.equal(payload.trust && "scope" in payload.trust, false);

  const text = element.textContent ?? "";
  assert.match(text, /not remembered/i);
  assert.doesNotMatch(text, /approved automatically/i);
});

test("a response with a trustRule reports the standing grant", async () => {
  respondToConfirmation.mockResolvedValue({
    confirmation: { status: "approved" },
    resume: { decisions: [{ type: "approve" }] },
    trustRule: {
      id: "rule-1",
      teamId: "team-1",
      workspaceId: "workspace-1",
      userId: "user-1",
      domain: "connector",
      toolName: "some_tool",
      connectorId: "c-1",
      targetType: null,
      targetId: null,
      allowedRiskLevels: ["high"],
      status: "active",
      expiresAt: "2099-01-01T00:00:00.000Z",
      createdFromConfirmationId: "confirmation-1",
      lastUsedAt: null,
      createdAt: "2026-07-21T00:00:00.000Z",
      updatedAt: "2026-07-21T00:00:00.000Z",
    },
  });
  const element = await render(
    createItem({
      decisionOptions: [
        { decision: "reject", label: "Reject" },
        { decision: "approve", label: "Approve" },
        { decision: "approve_always", label: "Always allow" },
      ],
    }),
  );
  await act(async () => {
    clickButton(element, "Always allow").click();
  });

  const text = element.textContent ?? "";
  assert.match(text, /approved automatically until/i);
  assert.doesNotMatch(text, /not remembered/i);
});
