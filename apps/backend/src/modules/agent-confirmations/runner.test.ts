import assert from "node:assert/strict";
import { test, vi } from "vitest";
import type { ToolConfirmationRequest } from "@sourceweft/contracts";

const mocks = vi.hoisted(() => ({
  mcpRespondToApproval: vi.fn(),
}));

vi.mock("../mcp", () => ({
  mcpService: {
    respondToApproval: mocks.mcpRespondToApproval,
  },
}));

vi.mock("../connectors", () => ({
  ConnectorError: class ConnectorError extends Error {
    statusCode: number;
    code: string;
    constructor(statusCode: number, code: string, message: string) {
      super(message);
      this.statusCode = statusCode;
      this.code = code;
    }
  },
  connectorActionRunner: {},
  connectorRegistry: {
    listManifests: vi.fn(() => []),
  },
}));

vi.mock("../connectors/repository", () => ({
  findActionRunRecordById: vi.fn(),
  findSourceConnectorRecord: vi.fn(),
}));

vi.mock("../connectors/permissions", () => ({
  requireConnectorWorkspace: vi.fn(),
}));

vi.mock("../connectors/agent-tool-payload", () => ({
  connectorActionApprovalPayload: vi.fn(),
}));

import { ToolConfirmationRunner } from "./runner";

function mcpConfirmation(): ToolConfirmationRequest {
  return {
    type: "tool_confirmation_request",
    schemaVersion: 1,
    id: "mcp_action_1",
    domain: "mcp",
    subject: {
      label: "GitHub",
      provider: "mcp",
      externalUri: "https://mcp.example.com/mcp",
    },
    action: {
      type: "create_issue",
      toolName: "mcp__github__create_issue",
      label: "Create issue",
      riskLevel: "high",
      status: "proposed",
      requiresApproval: true,
    },
    preview: {
      title: "Write MCP call: GitHub.create_issue",
      requestJson: { title: "Original" },
    },
    editableArgs: {
      value: { title: "Original" },
      schema: { type: "object" },
    },
    decisionOptions: [
      { decision: "reject", label: "Reject" },
      { decision: "approve", label: "Approve" },
    ],
    execution: {
      providerStatus: "not_executed",
      executor: {
        kind: "mcp_action_run",
        actionRunId: "mcp_action_1",
      },
    },
    status: "proposed",
    userMessage: "Waiting for confirmation.",
  };
}

test("ToolConfirmationRunner forwards edited args to MCP approvals", async () => {
  const confirmation = mcpConfirmation();
  mocks.mcpRespondToApproval.mockResolvedValue({
    confirmation,
    resume: { decisions: [{ type: "approve" }] },
  });

  const result = await new ToolConfirmationRunner().respond({
    workspaceId: "workspace_1",
    userId: "user_1",
    confirmationId: "mcp_action_1",
    confirmation,
    decision: "approve",
    editedArgs: { title: "Edited" },
    note: "Looks good",
  });

  assert.deepEqual(mocks.mcpRespondToApproval.mock.calls[0]?.[0], {
    workspaceId: "workspace_1",
    userId: "user_1",
    confirmationId: "mcp_action_1",
    confirmation,
    decision: "approve",
    editedArgs: { title: "Edited" },
    note: "Looks good",
  });
  assert.deepEqual(result.resume, { decisions: [{ type: "approve" }] });
});
