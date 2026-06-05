import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { ConnectorError } from "./errors";
import { connectorActionRunner, connectorOAuthService } from ".";
import { connectorToolResult } from "./agent-tool-errors";
import * as connectorRepository from "./repository";
import type { ConnectorActionRunRecord, SourceConnectorRecord } from "./types";
import {
  chooseConnector,
  connectorActionApprovalPayload,
} from "./agent-tool-payload";
import {
  createConnectorActionInterruptConfigs,
  createConnectorActionTools,
} from "./agent-tools";
import {
  buildConnectorActionApprovalIdempotencyKey,
  buildConnectorActionApprovalScope,
  peekConnectorActionExecutionRef,
  resolveConnectorActionExecutionRef,
  resolveConnectorActionToolIdempotencyKey,
  type ConnectorActionExecutionCursor,
} from "./agent-tool-idempotency";
import { logger } from "../../shared/logger";

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

type InvokableConnectorTool = {
  invoke(input: Record<string, unknown>): Promise<unknown>;
  name: string;
};

function asInvokableConnectorTool(value: unknown): InvokableConnectorTool {
  assert.ok(value);
  return value as InvokableConnectorTool;
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
      description: "Create a fake item in the target service.",
      displayName: "Create fake item",
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
        label: "Create fake item",
        description: "Create a fake item in the target service.",
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
        sourceweft: { toolCallId: "key" },
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
      description: "Create a fake item in the target service.",
      displayName: "Create fake item",
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
        label: "Create fake item",
        description: "Create a fake item in the target service.",
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
        sourceweft: { toolCallId: "key" },
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
  assert.equal(configs.read_notion_page, undefined);
  assert.deepEqual(configs.update_notion_page?.allowedDecisions, [
    "approve",
    "edit",
    "reject",
  ]);
  assert.deepEqual(configs.delete_notion_page?.allowedDecisions, [
    "approve",
    "reject",
  ]);
  assert.ok(configs.update_notion_page?.argsSchema);
  assert.ok(configs.delete_notion_page?.argsSchema);
});

test("createConnectorActionApprovalRequest includes connector tool display metadata", async () => {
  const listConnectors = vi
    .spyOn(connectorRepository, "listSourceConnectorRecords")
    .mockResolvedValue([
      connector({
        connectorType: "notion",
        name: "Notion",
      }),
    ]);
  const propose = vi.spyOn(connectorActionRunner, "propose").mockResolvedValue({
    action: action({
      actionType: "notion.page.trash",
      agentToolName: "delete_notion_page",
      connectorType: "notion",
      riskLevel: "high",
      requestJson: { pageId: "page_1" },
      requestPreview: "notion.page.trash on page_1",
    }),
  });

  try {
    const { createConnectorActionApprovalRequest } = await import(
      "./agent-tools"
    );
    const confirmation = await createConnectorActionApprovalRequest(
      {
        teamId: "team_1",
        workspaceId: "workspace_1",
        userId: "user_1",
      },
      {
        args: { pageId: "page_1" },
        toolCallId: "tool_call_1",
        toolName: "delete_notion_page",
      },
    );

    assert.equal(confirmation?.action.label, "Move Notion page to trash");
    assert.match(
      confirmation?.action.description ?? "",
      /Move one or more existing Notion pages to trash by page ID/,
    );
    assert.equal(
      confirmation?.execution.sourceweft?.toolCallId,
      "tool_call_1",
    );
  } finally {
    listConnectors.mockRestore();
    propose.mockRestore();
  }
});

test("connector action approval idempotency is stable across HITL replay", () => {
  const scope = buildConnectorActionApprovalScope({
    threadId: "agent-thread-1",
    checkpointId: "interrupt-checkpoint-1",
  });
  const proposalContext = {
    actionApprovalCursor: { value: 0 },
    actionApprovalScope: scope,
  };
  const replayContext = {
    actionApprovalCursor: { value: 0 },
    actionApprovalScope: scope,
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
      scope,
      toolName: "create_notion_page",
    }),
  );
  assert.equal(replayCreateKey, proposalCreateKey);
  assert.equal(
    proposalAppendKey,
    buildConnectorActionApprovalIdempotencyKey({
      index: 1,
      scope,
      toolName: "append_notion_page",
    }),
  );
  assert.equal(replayAppendKey, proposalAppendKey);
});

test("connector action approval idempotency separates later HITL pauses in one thread", () => {
  const firstScope = buildConnectorActionApprovalScope({
    threadId: "agent-thread-1",
    checkpointId: "interrupt-checkpoint-1",
  });
  const secondScope = buildConnectorActionApprovalScope({
    threadId: "agent-thread-1",
    checkpointId: "interrupt-checkpoint-2",
  });

  const firstDeleteKey = resolveConnectorActionToolIdempotencyKey(
    {
      actionApprovalCursor: { value: 0 },
      actionApprovalScope: firstScope,
    },
    {
      fallback: "first-runtime-tool-call-id",
      toolName: "delete_notion_page",
    },
  );
  const secondDeleteKey = resolveConnectorActionToolIdempotencyKey(
    {
      actionApprovalCursor: { value: 0 },
      actionApprovalScope: secondScope,
    },
    {
      fallback: "second-runtime-tool-call-id",
      toolName: "delete_notion_page",
    },
  );

  assert.notEqual(firstDeleteKey, secondDeleteKey);
  assert.equal(
    firstDeleteKey,
    buildConnectorActionApprovalIdempotencyKey({
      index: 0,
      scope: firstScope,
      toolName: "delete_notion_page",
    }),
  );
  assert.equal(
    secondDeleteKey,
    buildConnectorActionApprovalIdempotencyKey({
      index: 0,
      scope: secondScope,
      toolName: "delete_notion_page",
    }),
  );
});

test("connector action approval scope falls back to thread before checkpoint is known", () => {
  assert.equal(
    buildConnectorActionApprovalScope({
      threadId: "agent-thread-1",
      checkpointId: null,
    }),
    "agent-thread-1",
  );
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

test("connector action execution refs skip stale actions and match resumed args", () => {
  const context = {
    actionExecutionCursor: {
      refs: [
        {
          actionRunId: "delete_action",
          connectorId: "connector_1",
          requestJson: { pageId: "old_page" },
          toolName: "delete_notion_page",
        },
        {
          actionRunId: "append_action",
          connectorId: "connector_1",
          requestJson: { content: "Summary", pageId: "test_page" },
          toolName: "append_notion_page",
        },
      ],
      value: 0,
    },
  };

  assert.deepEqual(
    resolveConnectorActionExecutionRef(context, {
      connectorId: "connector_1",
      requestJson: { pageId: "test_page", content: "Summary" },
      toolName: "append_notion_page",
    }),
    {
      actionRunId: "append_action",
      connectorId: "connector_1",
      requestJson: { content: "Summary", pageId: "test_page" },
      toolName: "append_notion_page",
    },
  );
});

test("connector action execution refs ignore undefined optional args from replay", () => {
  const context = {
    actionExecutionCursor: {
      refs: [
        {
          actionRunId: "create_action",
          connectorId: "connector_1",
          requestJson: {
            title: "Demo",
            content: "Body",
            parentPageId: "parent_page",
          },
          toolName: "create_notion_page",
        },
      ],
      value: 0,
    },
  };

  assert.deepEqual(
    resolveConnectorActionExecutionRef(context, {
      connectorId: "connector_1",
      requestJson: {
        title: "Demo",
        content: "Body",
        parentPageId: "parent_page",
        dataSourceId: undefined,
        pageId: undefined,
      },
      toolName: "create_notion_page",
    }),
    {
      actionRunId: "create_action",
      connectorId: "connector_1",
      requestJson: {
        title: "Demo",
        content: "Body",
        parentPageId: "parent_page",
      },
      toolName: "create_notion_page",
    },
  );
});

test("connector action execution refs can match later approved edits by args", () => {
  const context = {
    actionExecutionCursor: {
      refs: [
        {
          actionRunId: "first_append",
          connectorId: "connector_1",
          requestJson: { content: "Old summary", pageId: "test_page" },
          toolName: "append_notion_page",
        },
        {
          actionRunId: "second_append",
          connectorId: "connector_1",
          requestJson: { content: "Updated summary", pageId: "test_page" },
          toolName: "append_notion_page",
        },
      ],
      value: 1,
    },
  };

  assert.deepEqual(
    resolveConnectorActionExecutionRef(context, {
      connectorId: "connector_1",
      requestJson: { content: "Old summary", pageId: "test_page" },
      toolName: "append_notion_page",
    }),
    {
      actionRunId: "first_append",
      connectorId: "connector_1",
      requestJson: { content: "Old summary", pageId: "test_page" },
      toolName: "append_notion_page",
    },
  );
  assert.deepEqual(
    resolveConnectorActionExecutionRef(context, {
      connectorId: "connector_1",
      requestJson: { content: "Updated summary", pageId: "test_page" },
      toolName: "append_notion_page",
    }),
    {
      actionRunId: "second_append",
      connectorId: "connector_1",
      requestJson: { content: "Updated summary", pageId: "test_page" },
      toolName: "append_notion_page",
    },
  );
});

test("connector action execution refs can be inspected without consuming them", () => {
  const actionExecutionCursor: ConnectorActionExecutionCursor = {
    refs: [
      {
        actionRunId: "delete_action",
        connectorId: "connector_1",
        requestJson: { pageId: "placeholder_page" },
        toolName: "delete_notion_page",
      },
    ],
    value: 0,
  };
  const context = {
    actionExecutionCursor,
  };

  assert.deepEqual(
    peekConnectorActionExecutionRef(context, {
      connectorId: "connector_1",
      requestJson: { pageId: "placeholder_page" },
      toolName: "delete_notion_page",
    }),
    {
      actionRunId: "delete_action",
      connectorId: "connector_1",
      requestJson: { pageId: "placeholder_page" },
      toolName: "delete_notion_page",
    },
  );
  assert.equal(context.actionExecutionCursor.value, 0);
  assert.equal(context.actionExecutionCursor.consumedActionRunIds, undefined);
  assert.deepEqual(
    resolveConnectorActionExecutionRef(context, {
      connectorId: "connector_1",
      requestJson: { pageId: "placeholder_page" },
      toolName: "delete_notion_page",
    }),
    {
      actionRunId: "delete_action",
      connectorId: "connector_1",
      requestJson: { pageId: "placeholder_page" },
      toolName: "delete_notion_page",
    },
  );
});

test("approval-required connector tools do not execute without an approved execution ref", async () => {
  const listConnectors = vi
    .spyOn(connectorRepository, "listSourceConnectorRecords")
    .mockResolvedValue([
      connector({
        connectorType: "notion",
        name: "Notion",
      }),
    ]);
  const propose = vi
    .spyOn(connectorActionRunner, "propose")
    .mockResolvedValue({
      action: action({
        actionType: "notion.page.trash",
        agentToolName: "delete_notion_page",
        connectorType: "notion",
        requestJson: { pageId: "page_1" },
      }),
    });
  const execute = vi
    .spyOn(connectorActionRunner, "execute")
    .mockResolvedValue({
      action: action({ status: "succeeded" }),
    });

  try {
    const tools = await createConnectorActionTools({
      teamId: "team_1",
      workspaceId: "workspace_1",
      userId: "user_1",
    });
    const deleteByTitle = asInvokableConnectorTool(
      tools.find(
        (candidate) => candidate.name === "delete_notion_page",
      ),
    );

    const result = await deleteByTitle.invoke({
      pageId: "page_1",
    });

    assert.deepEqual(propose.mock.calls[0]?.[0], {
      workspaceId: "workspace_1",
      userId: "user_1",
      connectorId: "connector_1",
      actionType: "notion.page.trash",
      agentToolName: "delete_notion_page",
      requestJson: { pageId: "page_1" },
      idempotencyKey: undefined,
    });
    assert.equal(execute.mock.calls.length, 0);
    assert.deepEqual(result, {
      type: "connector_tool_error",
      code: "CONNECTOR_ACTION_NOT_APPROVED",
      message:
        "Approved action was not found for this resumed tool call. Please retry the confirmation.",
      statusCode: 409,
      recoverable: true,
    });
  } finally {
    listConnectors.mockRestore();
    propose.mockRestore();
    execute.mockRestore();
  }
});

test("approval-required connector tools execute with an approved execution ref", async () => {
  const listConnectors = vi
    .spyOn(connectorRepository, "listSourceConnectorRecords")
    .mockResolvedValue([
      connector({
        connectorType: "notion",
        name: "Notion",
      }),
    ]);
  const propose = vi.spyOn(connectorActionRunner, "propose");
  const execute = vi
    .spyOn(connectorActionRunner, "execute")
    .mockResolvedValue({
      action: action({
        actionType: "notion.page.trash",
        agentToolName: "delete_notion_page",
        connectorType: "notion",
        resultJson: { trashed: true },
        status: "succeeded",
      }),
    });

  try {
    const tools = await createConnectorActionTools({
      actionExecutionCursor: {
        refs: [
          {
            actionRunId: "action_1",
            connectorId: "connector_1",
            toolName: "delete_notion_page",
          },
        ],
        value: 0,
      },
      teamId: "team_1",
      workspaceId: "workspace_1",
      userId: "user_1",
    });
    const deleteByTitle = asInvokableConnectorTool(
      tools.find(
        (candidate) => candidate.name === "delete_notion_page",
      ),
    );

    const result = await deleteByTitle.invoke({
      pageId: "page_1",
    });

    assert.equal(propose.mock.calls.length, 0);
    assert.deepEqual(execute.mock.calls[0]?.[0], {
      workspaceId: "workspace_1",
      userId: "user_1",
      connectorId: "connector_1",
      actionRunId: "action_1",
      expected: {
        actionType: "notion.page.trash",
        agentToolName: "delete_notion_page",
        requestJson: { pageId: "page_1" },
      },
    });
    assert.deepEqual(result, {
      trashed: true,
      actionType: "notion.page.trash",
      toolName: "delete_notion_page",
    });
  } finally {
    listConnectors.mockRestore();
    propose.mockRestore();
    execute.mockRestore();
  }
});

test("approval-required connector tools execute approved ref even when default connector changes", async () => {
  const listConnectors = vi
    .spyOn(connectorRepository, "listSourceConnectorRecords")
    .mockResolvedValue([
      connector({
        id: "connector_2",
        connectorType: "notion",
        name: "Other Notion",
      }),
      connector({
        connectorType: "notion",
        name: "Notion",
      }),
    ]);
  const propose = vi.spyOn(connectorActionRunner, "propose");
  const execute = vi
    .spyOn(connectorActionRunner, "execute")
    .mockResolvedValue({
      action: action({
        actionType: "notion.page.trash",
        agentToolName: "delete_notion_page",
        connectorType: "notion",
        resultJson: { trashed: true },
        status: "succeeded",
      }),
    });

  try {
    const tools = await createConnectorActionTools({
      actionExecutionCursor: {
        refs: [
          {
            actionRunId: "action_1",
            connectorId: "connector_1",
            requestJson: { pageId: "page_1" },
            toolName: "delete_notion_page",
          },
        ],
        value: 0,
      },
      teamId: "team_1",
      workspaceId: "workspace_1",
      userId: "user_1",
    });
    const deleteByTitle = asInvokableConnectorTool(
      tools.find(
        (candidate) => candidate.name === "delete_notion_page",
      ),
    );

    const result = await deleteByTitle.invoke({
      pageId: "page_1",
    });

    assert.equal(propose.mock.calls.length, 0);
    assert.deepEqual(execute.mock.calls[0]?.[0], {
      workspaceId: "workspace_1",
      userId: "user_1",
      connectorId: "connector_1",
      actionRunId: "action_1",
      expected: {
        actionType: "notion.page.trash",
        agentToolName: "delete_notion_page",
        requestJson: { pageId: "page_1" },
      },
    });
    assert.deepEqual(result, {
      trashed: true,
      actionType: "notion.page.trash",
      toolName: "delete_notion_page",
    });
  } finally {
    listConnectors.mockRestore();
    propose.mockRestore();
    execute.mockRestore();
  }
});

test("search_notion_pages returns recoverable error for empty query", async () => {
  const listConnectors = vi
    .spyOn(connectorRepository, "listSourceConnectorRecords")
    .mockResolvedValue([
      connector({
        connectorType: "notion",
        name: "Notion",
      }),
    ]);
  const runtimeToken = vi
    .spyOn(connectorOAuthService, "getRuntimeToken")
    .mockResolvedValue("runtime-token");
  const errorLog = vi.spyOn(logger, "error").mockImplementation(() => undefined);
  const originalFetch = globalThis.fetch;
  const fetchMock = vi.fn();
  globalThis.fetch = fetchMock;

  try {
    const tools = await createConnectorActionTools({
      teamId: "team_1",
      workspaceId: "workspace_1",
      userId: "user_1",
    });
    const searchPages = asInvokableConnectorTool(
      tools.find((candidate) => candidate.name === "search_notion_pages"),
    );

    for (const query of ["", "   "]) {
      const result = await searchPages.invoke({ query });

      assert.deepEqual(result, {
        type: "connector_tool_error",
        code: "CONNECTOR_TOOL_INPUT_INVALID",
        message:
          "search_notion_pages requires a non-empty page title, keyword, or topic. Ask the user what Notion page to find.",
        statusCode: 400,
        recoverable: true,
      });
    }
    assert.equal(fetchMock.mock.calls.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    errorLog.mockRestore();
    runtimeToken.mockRestore();
    listConnectors.mockRestore();
  }
});

test("direct connector tools log raw adapter responses", async () => {
  const listConnectors = vi
    .spyOn(connectorRepository, "listSourceConnectorRecords")
    .mockResolvedValue([
      connector({
        connectorType: "notion",
        name: "Notion",
      }),
    ]);
  const runtimeToken = vi
    .spyOn(connectorOAuthService, "getRuntimeToken")
    .mockResolvedValue("runtime-token");
  const debug = vi.spyOn(logger, "debug").mockImplementation(() => undefined);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: URL | RequestInfo) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith("/search")) {
      return new Response(
        JSON.stringify({
          results: [
            {
              object: "page",
              id: "page_1",
              url: "https://www.notion.so/page_1",
              last_edited_time: "2026-05-02T00:00:00.000Z",
              properties: {
                Name: {
                  type: "title",
                  title: [{ plain_text: "Roadmap" }],
                },
              },
            },
          ],
          has_more: false,
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }
    return new Response(JSON.stringify({ results: [], has_more: false }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const tools = await createConnectorActionTools({
      teamId: "team_1",
      workspaceId: "workspace_1",
      userId: "user_1",
    });
    const searchPages = asInvokableConnectorTool(
      tools.find((candidate) => candidate.name === "search_notion_pages"),
    );

    const result = await searchPages.invoke({ query: "Roadmap" });

    assert.deepEqual(result, {
      query: "Roadmap",
      resultCount: 1,
      pages: [
        {
          pageId: "page_1",
          title: "Roadmap",
          url: "https://www.notion.so/page_1",
          lastEditedTime: "2026-05-02T00:00:00.000Z",
        },
      ],
      actionType: "notion.page.find",
      toolName: "search_notion_pages",
    });
    const successLog = debug.mock.calls.find(
      ([message]) =>
        message === "Connector action direct adapter execution succeeded",
    );
    assert.ok(successLog);
    assert.deepEqual((successLog[1] as Record<string, unknown>).rawResponseJson, [
      {
        body: {
          results: [
            {
              object: "page",
              id: "page_1",
              url: "https://www.notion.so/page_1",
              last_edited_time: "2026-05-02T00:00:00.000Z",
              properties: {
                Name: {
                  type: "title",
                  title: [{ plain_text: "Roadmap" }],
                },
              },
            },
          ],
          has_more: false,
        },
        method: "POST",
        path: "/search",
        status: 200,
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    debug.mockRestore();
    runtimeToken.mockRestore();
    listConnectors.mockRestore();
  }
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
