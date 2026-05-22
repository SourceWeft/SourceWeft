import assert from "node:assert/strict";
import { test } from "vitest";
import { ConnectorError } from "./errors";
import { connectorToolResult } from "./agent-tool-errors";
import type { ConnectorActionRunRecord, SourceConnectorRecord } from "./types";
import {
  chooseConnector,
  connectorActionApprovalPayload,
} from "./agent-tool-payload";
import { createConnectorActionInterruptConfigs } from "./agent-tools";
import {
  buildConnectorActionApprovalIdempotencyKey,
  resolveConnectorActionExecutionRef,
  resolveConnectorActionToolIdempotencyKey,
} from "./agent-tool-idempotency";

function connector(
  input: Partial<SourceConnectorRecord> = {},
): SourceConnectorRecord {
  return {
    id: "connector_1",
    teamId: "team_1",
    workspaceId: "workspace_1",
    connectorType: "fake",
    name: "Fake",
    configJson: {},
    oauthAccountId: "account_1",
    status: "active",
    periodicIndexingEnabled: false,
    indexingFrequencyMinutes: null,
    lastIndexedAt: null,
    nextScheduledAt: null,
    lastError: null,
    createdBy: "user_1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...input,
  };
}

function action(
  input: Partial<ConnectorActionRunRecord> = {},
): ConnectorActionRunRecord {
  return {
    id: "action_1",
    teamId: "team_1",
    workspaceId: "workspace_1",
    connectorId: "connector_1",
    connectorType: "fake",
    actionType: "fake.item.create",
    agentToolName: "create_fake_item",
    riskLevel: "medium",
    status: "proposed",
    requestJson: { title: "Demo", accessToken: "secret" },
    requestPreview: "Create fake item: Demo",
    resultJson: {},
    externalId: null,
    idempotencyKey: "key",
    approvedBy: null,
    executedBy: null,
    errorCode: null,
    errorMessage: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...input,
  };
}

test("chooseConnector uses the only active connector by default", () => {
  assert.equal(
    chooseConnector({
      connectorType: "fake",
      connectors: [connector({ id: "connector_1" })],
    }).id,
    "connector_1",
  );
});

test("chooseConnector requires connectorId when multiple connectors exist", () => {
  assert.throws(
    () =>
      chooseConnector({
        connectorType: "fake",
        connectors: [
          connector({ id: "connector_1" }),
          connector({ id: "connector_2" }),
        ],
      }),
    (error) =>
      error instanceof ConnectorError &&
      error.code === "CONNECTOR_SELECTION_REQUIRED",
  );
});

test("connectorActionApprovalPayload returns structured redacted approval output", () => {
  assert.deepEqual(
    connectorActionApprovalPayload({
      action: action({}),
      agentToolName: "create_fake_item",
      connector: connector({}),
      target: {
        id: "page_1",
        label: "Private page in Notion workspace",
        type: "notion_private",
      },
    }),
    {
      type: "tool_confirmation_request",
      schemaVersion: 1,
      id: "action_1",
      domain: "connector",
      subject: {
        label: "Fake",
        provider: "fake",
        connectorId: "connector_1",
        externalUri: null,
      },
      action: {
        type: "fake.item.create",
        toolName: "create_fake_item",
        label: "Create",
        riskLevel: "medium",
        status: "proposed",
        requiresApproval: true,
      },
      preview: {
        title: "Create fake item: Demo",
        summary: "Create fake item: Demo",
        requestJson: {
          title: "Demo",
          accessToken: "[REDACTED]",
        },
        target: {
          type: "notion_private",
          label: "Private page in Notion workspace",
          id: "page_1",
          externalUri: null,
        },
      },
      editableArgs: {
        value: {
          title: "Demo",
          accessToken: "[REDACTED]",
        },
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            title: { type: "string" },
            accessToken: { type: "string" },
          },
        },
      },
      decisionOptions: [
        {
          decision: "reject",
          label: "Reject",
          description: "Do not run this action.",
        },
        {
          decision: "approve",
          label: "Approve",
          description: "Run this action once.",
        },
      ],
      execution: {
        providerStatus: "not_executed",
        executor: {
          kind: "connector_action_run",
          connectorId: "connector_1",
          actionRunId: "action_1",
        },
      },
      status: "proposed",
      userMessage:
        "This action is waiting for confirmation in SourceWeft. The external provider action has not executed yet.",
    },
  );
});

test("connectorActionApprovalPayload marks completed confirmations as succeeded", () => {
  assert.deepEqual(
    connectorActionApprovalPayload({
      action: action({ status: "succeeded" }),
      agentToolName: "create_fake_item",
      connector: connector({}),
    }),
    {
      type: "tool_confirmation_request",
      schemaVersion: 1,
      id: "action_1",
      domain: "connector",
      subject: {
        label: "Fake",
        provider: "fake",
        connectorId: "connector_1",
        externalUri: null,
      },
      action: {
        type: "fake.item.create",
        toolName: "create_fake_item",
        label: "Create",
        riskLevel: "medium",
        status: "succeeded",
        requiresApproval: true,
      },
      preview: {
        title: "Create fake item: Demo",
        summary: "Create fake item: Demo",
        requestJson: {
          title: "Demo",
          accessToken: "[REDACTED]",
        },
      },
      editableArgs: {
        value: {
          title: "Demo",
          accessToken: "[REDACTED]",
        },
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            title: { type: "string" },
            accessToken: { type: "string" },
          },
        },
      },
      decisionOptions: [
        {
          decision: "reject",
          label: "Reject",
          description: "Do not run this action.",
        },
        {
          decision: "approve",
          label: "Approve",
          description: "Run this action once.",
        },
      ],
      execution: {
        providerStatus: "succeeded",
        executor: {
          kind: "connector_action_run",
          connectorId: "connector_1",
          actionRunId: "action_1",
        },
      },
      status: "succeeded",
      userMessage:
        "This action finished successfully in SourceWeft.",
    },
  );
});

test("createConnectorActionInterruptConfigs registers approved agent actions", () => {
  process.env.NOTION_CLIENT_ID ??= "test-notion-client";
  const configs = createConnectorActionInterruptConfigs();

  assert.deepEqual(configs.create_notion_page?.allowedDecisions, [
    "approve",
    "edit",
    "reject",
  ]);
  assert.deepEqual(configs.delete_notion_page_by_title?.allowedDecisions, [
    "approve",
    "reject",
  ]);
});

test("connector action approval idempotency is stable across HITL replay", () => {
  const proposalContext = {
    actionApprovalCursor: { value: 0 },
    actionApprovalScope: "agent-thread-1",
  };
  const replayContext = {
    actionApprovalCursor: { value: 0 },
    actionApprovalScope: "agent-thread-1",
  };

  const proposalCreateKey = resolveConnectorActionToolIdempotencyKey(
    proposalContext,
    {
      fallback: "original-tool-call-id",
      toolName: "create_notion_page",
    },
  );
  const replayCreateKey = resolveConnectorActionToolIdempotencyKey(
    replayContext,
    {
      fallback: "replayed-tool-call-id",
      toolName: "create_notion_page",
    },
  );
  const proposalAppendKey = resolveConnectorActionToolIdempotencyKey(
    proposalContext,
    {
      fallback: "original-append-tool-call-id",
      toolName: "append_notion_page",
    },
  );
  const replayAppendKey = resolveConnectorActionToolIdempotencyKey(
    replayContext,
    {
      fallback: "replayed-append-tool-call-id",
      toolName: "append_notion_page",
    },
  );

  assert.equal(
    proposalCreateKey,
    buildConnectorActionApprovalIdempotencyKey({
      index: 0,
      scope: "agent-thread-1",
      toolName: "create_notion_page",
    }),
  );
  assert.equal(replayCreateKey, proposalCreateKey);
  assert.equal(
    proposalAppendKey,
    buildConnectorActionApprovalIdempotencyKey({
      index: 1,
      scope: "agent-thread-1",
      toolName: "append_notion_page",
    }),
  );
  assert.equal(replayAppendKey, proposalAppendKey);
});

test("connector action approval idempotency falls back outside HITL", () => {
  assert.equal(
    resolveConnectorActionToolIdempotencyKey(
      {},
      {
        fallback: "runtime-tool-call-id",
        toolName: "create_notion_page",
      },
    ),
    "runtime-tool-call-id",
  );
});

test("connector action execution refs are consumed in replay order", () => {
  const context = {
    actionExecutionCursor: {
      refs: [
        {
          actionRunId: "action_1",
          connectorId: "connector_1",
          toolName: "create_notion_page",
        },
        {
          actionRunId: "action_2",
          connectorId: "connector_1",
          toolName: "append_notion_page",
        },
      ],
      value: 0,
    },
  };

  assert.deepEqual(
    resolveConnectorActionExecutionRef(context, {
      connectorId: "connector_1",
      toolName: "create_notion_page",
    }),
    {
      actionRunId: "action_1",
      connectorId: "connector_1",
      toolName: "create_notion_page",
    },
  );
  assert.equal(
    resolveConnectorActionExecutionRef(context, {
      connectorId: "connector_1",
      toolName: "create_notion_page",
    }),
    null,
  );
  assert.deepEqual(
    resolveConnectorActionExecutionRef(context, {
      connectorId: "connector_1",
      toolName: "append_notion_page",
    }),
    {
      actionRunId: "action_2",
      connectorId: "connector_1",
      toolName: "append_notion_page",
    },
  );
});

test("connectorToolResult returns structured errors for unexpected failures", async () => {
  const result = await connectorToolResult(() => {
    throw new Error("database exploded");
  });

  assert.deepEqual(result, {
    type: "connector_tool_error",
    code: "CONNECTOR_OPERATION_FAILED",
    message: "Connector tool failed. Check backend logs for details.",
    statusCode: 500,
  });
});

test("connectorToolResult surfaces migration guidance for missing action-run columns", async () => {
  const error = new Error(
    'column "connector_action_runs"."agent_tool_name" does not exist',
  ) as Error & { code: string };
  error.code = "42703";

  const result = await connectorToolResult(() => {
    throw error;
  });

  assert.deepEqual(result, {
    type: "connector_tool_error",
    code: "CONNECTOR_MIGRATION_REQUIRED",
    message:
      "Connector action approval storage is not up to date. Run backend migrations, then restart the worker.",
    statusCode: 503,
  });
});
