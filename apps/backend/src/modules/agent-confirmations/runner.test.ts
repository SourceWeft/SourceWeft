import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
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
  connectorActionRunner: {
    get: vi.fn(),
    reject: vi.fn(),
  },
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
import { connectorActionRunner } from "../connectors";
import { connectorActionApprovalPayload } from "../connectors/agent-tool-payload";
import { findSourceConnectorRecord } from "../connectors/repository";
import { requireConnectorWorkspace } from "../connectors/permissions";

beforeEach(() => {
  vi.clearAllMocks();
});

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

function sandboxConfirmation(
  overrides: Partial<ToolConfirmationRequest> = {},
): ToolConfirmationRequest {
  return {
    type: "tool_confirmation_request",
    schemaVersion: 1,
    id: "sandbox_call_1",
    domain: "sandbox",
    subject: { label: "Sandbox runtime", provider: "sandbox" },
    action: {
      type: "execute",
      toolName: "execute",
      label: "execute",
      riskLevel: "high",
      status: "proposed",
      requiresApproval: true,
    },
    preview: {
      title: "Review sandbox action: execute",
      requestJson: { command: "npm test" },
    },
    editableArgs: {
      value: { command: "npm test" },
      schema: { type: "object" },
    },
    decisionOptions: [
      { decision: "reject", label: "Reject" },
      { decision: "approve", label: "Approve" },
    ],
    execution: {
      providerStatus: "not_executed",
      executor: { kind: "sandbox_tool_call" },
      sourceweft: {
        hitlInterruptId: "sandbox-interrupt-1",
        actionIndex: 0,
        toolName: "execute",
        requestJson: { command: "npm test" },
        hitlActionIndex: 0,
        hitlActionToolName: "execute",
        hitlActionRequestJson: { command: "npm test" },
        toolCallId: "sandbox_call_1",
        sourceUserMessageId: "user-message-1",
        sourceAssistantMessageId: "assistant-message-1",
      },
    },
    status: "proposed",
    userMessage: "Waiting for sandbox action confirmation.",
    ...overrides,
  };
}

test("ToolConfirmationRunner forwards edited args to MCP approvals", async () => {
  const confirmation = {
    ...mcpConfirmation(),
    execution: {
      ...mcpConfirmation().execution,
      sourceweft: {
        hitlInterruptId: "interrupt-1",
        actionIndex: 0,
        toolName: "mcp__github__create_issue",
        requestJson: { title: "Create issue" },
        toolCallId: "call-mcp-1",
      },
    },
  };
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
  assert.deepEqual(result.resume, {
    decisions: [{ type: "approve" }],
    sourceweft: { hitlInterruptId: "interrupt-1" },
  });
});

test("ToolConfirmationRunner resumes approved sandbox HITL edits locally", async () => {
  const confirmation = sandboxConfirmation();

  const result = await new ToolConfirmationRunner().respond({
    workspaceId: "workspace_1",
    userId: "user_1",
    confirmationId: "sandbox_call_1",
    confirmation,
    decision: "approve",
    editedArgs: { command: "pnpm test", workingDir: "/workspace/ppt-deck" },
  });

  assert.equal(result.confirmation.status, "approved");
  assert.deepEqual(result.resume, {
    decisions: [
      {
        type: "edit",
        editedAction: {
          name: "execute",
          args: { command: "pnpm test", workingDir: "/workspace/ppt-deck" },
        },
      },
    ],
    sourceweft: {
      confirmationId: "sandbox_call_1",
      hitlInterruptId: "sandbox-interrupt-1",
      sourceUserMessageId: "user-message-1",
      sourceAssistantMessageId: "assistant-message-1",
      sandboxActions: [
        {
          toolName: "execute",
          toolCallId: "sandbox_call_1",
          requestJson: { command: "pnpm test", workingDir: "/workspace/ppt-deck" },
          confirmationId: "sandbox_call_1",
          hitlInterruptId: "sandbox-interrupt-1",
          sourceUserMessageId: "user-message-1",
          sourceAssistantMessageId: "assistant-message-1",
        },
      ],
    },
  });
  assert.equal(mocks.mcpRespondToApproval.mock.calls.length, 0);
});

test("ToolConfirmationRunner resumes approved sandbox HITL without edits locally", async () => {
  const confirmation = sandboxConfirmation();

  const result = await new ToolConfirmationRunner().respond({
    workspaceId: "workspace_1",
    userId: "user_1",
    confirmationId: "sandbox_call_1",
    confirmation,
    decision: "approve",
  });

  assert.equal(result.confirmation.status, "approved");
  assert.equal(result.confirmation.action.status, "approved");
  assert.deepEqual(result.resume, {
    decisions: [{ type: "approve" }],
    sourceweft: {
      confirmationId: "sandbox_call_1",
      hitlInterruptId: "sandbox-interrupt-1",
      sourceUserMessageId: "user-message-1",
      sourceAssistantMessageId: "assistant-message-1",
      sandboxActions: [
        {
          toolName: "execute",
          toolCallId: "sandbox_call_1",
          requestJson: { command: "npm test" },
          confirmationId: "sandbox_call_1",
          hitlInterruptId: "sandbox-interrupt-1",
          sourceUserMessageId: "user-message-1",
          sourceAssistantMessageId: "assistant-message-1",
        },
      ],
    },
  });
  assert.equal(mocks.mcpRespondToApproval.mock.calls.length, 0);
});

test("ToolConfirmationRunner uses default sandbox rejection note locally", async () => {
  const confirmation = sandboxConfirmation({ id: "sandbox_call_2" });

  const result = await new ToolConfirmationRunner().respond({
    workspaceId: "workspace_1",
    userId: "user_1",
    confirmationId: "sandbox_call_2",
    confirmation,
    decision: "reject",
  });

  assert.equal(result.confirmation.status, "rejected");
  assert.equal(result.confirmation.action.status, "rejected");
  assert.deepEqual(result.resume, {
    decisions: [
      {
        type: "reject",
        message: "User rejected the sandbox action in SourceWeft.",
      },
    ],
    sourceweft: {
      confirmationId: "sandbox_call_2",
      hitlInterruptId: "sandbox-interrupt-1",
      sourceUserMessageId: "user-message-1",
      sourceAssistantMessageId: "assistant-message-1",
    },
  });
  assert.equal(mocks.mcpRespondToApproval.mock.calls.length, 0);
});

test("ToolConfirmationRunner resumes DeepAgents HITL after connector rejection without execution refs", async () => {
  const confirmation: ToolConfirmationRequest = {
    type: "tool_confirmation_request",
    schemaVersion: 1,
    id: "connector_action_1",
    domain: "connector",
    subject: {
      label: "Notion",
      provider: "notion",
      connectorId: "connector-1",
    },
    action: {
      type: "notion.page.create",
      toolName: "create_notion_page",
      label: "Create page",
      riskLevel: "medium",
      status: "proposed",
      requiresApproval: true,
    },
    preview: {
      title: "Create Notion page",
      requestJson: { title: "Rejected page" },
    },
    decisionOptions: [
      { decision: "reject", label: "Reject" },
      { decision: "approve", label: "Approve" },
    ],
    execution: {
      providerStatus: "not_executed",
      executor: {
        kind: "connector_action_run",
        connectorId: "connector-1",
        actionRunId: "connector_action_1",
      },
      sourceweft: { hitlInterruptId: "interrupt-1" },
    },
    status: "proposed",
    userMessage: "Waiting for confirmation.",
  };
  vi.mocked(requireConnectorWorkspace).mockResolvedValue({
    workspace: { id: "workspace_1", organizationId: "team_1" },
  } as never);
  vi.mocked(connectorActionRunner.get).mockResolvedValue({
    action: {
      id: "connector_action_1",
      actionType: "notion.page.create",
      agentToolName: "create_notion_page",
      connectorId: "connector-1",
      connectorType: "notion",
      requestJson: { title: "Rejected page" },
      status: "proposed",
    },
  } as never);
  vi.mocked(findSourceConnectorRecord).mockResolvedValue({
    id: "connector-1",
    connectorType: "notion",
  } as never);
  vi.mocked(connectorActionRunner.reject).mockResolvedValue({
    action: {
      id: "connector_action_1",
      actionType: "notion.page.create",
      agentToolName: "create_notion_page",
      connectorId: "connector-1",
      connectorType: "notion",
      requestJson: { title: "Rejected page" },
      status: "rejected",
    },
  } as never);
  vi.mocked(connectorActionApprovalPayload).mockReturnValue({
    ...confirmation,
    status: "rejected",
    action: { ...confirmation.action, status: "rejected" },
  });

  const result = await new ToolConfirmationRunner().respond({
    workspaceId: "workspace_1",
    userId: "user_1",
    confirmationId: "connector_action_1",
    confirmation,
    decision: "reject",
  });

  assert.deepEqual(result.resume, {
    decisions: [
      {
        type: "reject",
        message: "User rejected the action in SourceWeft.",
      },
    ],
    sourceweft: { hitlInterruptId: "interrupt-1" },
  });
});

test("ToolConfirmationRunner resumes rejected sandbox HITL locally", async () => {
  const confirmation: ToolConfirmationRequest = {
    type: "tool_confirmation_request",
    schemaVersion: 1,
    id: "sandbox_call_2",
    domain: "sandbox",
    subject: { label: "Sandbox runtime", provider: "sandbox" },
    action: {
      type: "collect_sandbox_outputs",
      toolName: "collect_sandbox_outputs",
      label: "collectSandboxOutputs",
      riskLevel: "high",
      status: "proposed",
      requiresApproval: true,
    },
    preview: {
      title: "Review sandbox action: collect_sandbox_outputs",
      requestJson: {
        outputs: [
          {
            sandboxPath: "/workspace/output/report.md",
            target: { kind: "workfile", path: "/workfiles/report.md" },
          },
        ],
      },
    },
    decisionOptions: [
      { decision: "reject", label: "Reject" },
      { decision: "approve", label: "Approve" },
    ],
    execution: {
      providerStatus: "not_executed",
      executor: { kind: "sandbox_tool_call" },
    },
    status: "proposed",
    userMessage: "Waiting for sandbox action confirmation.",
  };

  const result = await new ToolConfirmationRunner().respond({
    workspaceId: "workspace_1",
    userId: "user_1",
    confirmationId: "sandbox_call_2",
    confirmation,
    decision: "reject",
    note: "Do not persist this output.",
  });

  assert.equal(result.confirmation.status, "rejected");
  assert.deepEqual(result.resume, {
    decisions: [{ type: "reject", message: "Do not persist this output." }],
  });
  assert.equal(mocks.mcpRespondToApproval.mock.calls.length, 0);
});
