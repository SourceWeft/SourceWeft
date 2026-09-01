import assert from "node:assert/strict";
import { test } from "vitest";
import {
  getToolConfirmationRunKey,
  initialToolConfirmationControllerState,
  settleToolConfirmationDecision,
  stopToolConfirmationRun,
  syncToolConfirmationRun,
} from "./tool-confirmation-controller";
import {
  combineToolApprovalResumes,
  deriveTerminalToolConfirmationResolutions,
  getLiveToolConfirmationItemsForRun,
  getPendingToolConfirmationItems,
  getToolConfirmationItemsForRun,
  getVisibleToolConfirmationItems,
  hasLiveToolConfirmationSignalForRun,
  isExpiredToolConfirmationResponse,
  isStaleToolConfirmationResponse,
  isToolCallActivelyRunning,
  mergeToolConfirmationResolutions,
  orderToolConfirmationResolutions,
  shouldLockComposerForApproval,
  shouldLockComposerForRun,
  type ToolConfirmationItem,
  updateToolConfirmationOrder,
} from "./tool-confirmation-state";
import type {
  AssistantVersionIndexEntry,
  MessageVersion,
  ToolConfirmationInterventionSignal,
  ToolCallRecord,
  ToolConfirmationResolution,
  VersionedMessageGroup,
} from "./types";

function createConfirmationItem(
  id: string,
  input: Partial<Pick<ToolConfirmationItem, "threadRunId">> = {},
): ToolConfirmationItem {
  const toolCall: ToolCallRecord = {
    id: `tool-${id}`,
    tool: "delete_notion_page",
    input: {},
    output: null,
    latencyMs: 0,
    status: "approval_requested",
    error: null,
  };

  return {
    assistantMessageId: "assistant-1",
    messageId: "assistant-1",
    threadRunId: input.threadRunId ?? "run-1",
    toolCall,
    confirmation: {
      type: "tool_confirmation_request",
      schemaVersion: 1,
      id,
      domain: "connector",
      subject: {
        label: "Lei Qin",
        provider: "notion",
        connectorId: "connector-1",
      },
      action: {
        type: "notion.page.trash",
        toolName: "delete_notion_page",
        label: "Delete",
        riskLevel: "high",
        status: "proposed",
        requiresApproval: true,
      },
      preview: {
        title: `Delete Notion page: ${id}`,
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
          actionRunId: id,
        },
      },
      status: "proposed",
      userMessage: "Waiting for confirmation.",
    },
  };
}

function createVersion(
  id: string,
  input: {
    confirmationId?: string;
    threadRunId?: string;
    threadRunStatus?: string;
  } = {},
): MessageVersion {
  const item = createConfirmationItem(input.confirmationId ?? id, {
    threadRunId: input.threadRunId ?? "run-1",
  });
  return {
    id,
    content: "",
    threadRun: {
      id: input.threadRunId ?? "run-1",
      status: input.threadRunStatus ?? "waiting_for_approval",
    },
    toolCalls: [
      {
        ...item.toolCall,
        output: item.confirmation,
      },
    ],
  };
}

function createAssistantVersionIndex(
  entries: Array<{
    branchIndex?: number;
    groupId: string;
    version: MessageVersion;
  }>,
) {
  return new Map<string, AssistantVersionIndexEntry>(
    entries.map((entry) => [
      entry.version.id,
      {
        branchIndex: entry.branchIndex ?? 0,
        groupId: entry.groupId,
        version: entry.version,
      },
    ]),
  );
}

test("pending confirmation items are hidden only after their confirmation id resolves", () => {
  const items = [
    createConfirmationItem("action-1"),
    createConfirmationItem("action-2"),
  ];

  const pending = getPendingToolConfirmationItems(items, [
    { confirmationId: "action-1", decision: "approve" },
  ]);

  assert.deepEqual(
    pending.map((item) => item.confirmation.id),
    ["action-2"],
  );
});

test("confirmation controller clears stale resolutions when the active run changes", () => {
  const item = createConfirmationItem("action-1");
  const synced = syncToolConfirmationRun({
    items: [item],
    runKey: getToolConfirmationRunKey({
      id: "run-1",
      idempotencyKey: "key-1",
      status: "waiting_for_approval",
    }),
    state: initialToolConfirmationControllerState,
  });
  const stopped = stopToolConfirmationRun({
    items: [item],
    state: synced,
  });
  const afterRunCleared = syncToolConfirmationRun({
    items: [],
    runKey: null,
    state: stopped,
  });
  const newRunItem = createConfirmationItem("action-2", {
    threadRunId: "run-2",
  });
  const nextRun = syncToolConfirmationRun({
    items: [newRunItem],
    runKey: "run-2",
    state: afterRunCleared,
  });

  assert.deepEqual(afterRunCleared.resolutions, []);
  assert.deepEqual(nextRun.resolutions, []);
  assert.deepEqual(
    getPendingToolConfirmationItems([newRunItem], nextRun.resolutions).map(
      (pending) => pending.confirmation.id,
    ),
    ["action-2"],
  );
});

test("confirmation controller keeps resolutions when backend run id arrives", () => {
  const item = createConfirmationItem("action-1");
  const optimisticRunKey = getToolConfirmationRunKey({
    idempotencyKey: "key-1",
    status: "waiting_for_approval",
  });
  const synced = syncToolConfirmationRun({
    items: [item],
    runKey: optimisticRunKey,
    state: initialToolConfirmationControllerState,
  });
  const settled = settleToolConfirmationDecision({
    decision: "approve",
    item,
    items: [item],
    resume: {
      decisions: [{ type: "approve" }],
    },
    state: synced,
  }).state;
  const persistedRunKey = getToolConfirmationRunKey({
    id: "run-1",
    idempotencyKey: "key-1",
    status: "waiting_for_approval",
  });
  const resynced = syncToolConfirmationRun({
    items: [item],
    runKey: persistedRunKey,
    state: settled,
  });

  assert.equal(optimisticRunKey, "key-1");
  assert.equal(persistedRunKey, "key-1");
  assert.deepEqual(
    getPendingToolConfirmationItems([item], resynced.resolutions),
    [],
  );
});

test("confirmation controller resumes only after all active confirmations settle", () => {
  const firstItem = createConfirmationItem("action-1");
  const secondItem = createConfirmationItem("action-2");
  const items = [firstItem, secondItem];
  const synced = syncToolConfirmationRun({
    items,
    runKey: "run-1",
    state: initialToolConfirmationControllerState,
  });

  const first = settleToolConfirmationDecision({
    decision: "approve",
    item: firstItem,
    items,
    resume: {
      decisions: [{ type: "approve" }],
      sourceweft: {
        hitlInterruptId: "0123456789abcdef0123456789abcdef",
        connectorActions: [
          {
            actionRunId: "action-1",
            connectorId: "connector-1",
            toolName: "delete_notion_page",
          },
        ],
      },
    },
    state: synced,
  });

  assert.equal(first.missingResume, false);
  assert.equal(first.resumeEffect, null);
  assert.equal(first.state.activeIntervention?.id, "action-2");

  const second = settleToolConfirmationDecision({
    decision: "reject",
    item: secondItem,
    items,
    resume: {
      decisions: [{ type: "reject", message: "Skip this one." }],
    },
    state: first.state,
  });

  assert.equal(second.missingResume, false);
  assert.deepEqual(second.resumeEffect, {
    approvalThreadRunId: "run-1",
    assistantMessageId: "assistant-1",
    resolvedConfirmationIds: ["action-1", "action-2"],
    toolApprovalResume: {
      decisions: [
        { type: "approve" },
        { type: "reject", message: "Skip this one." },
      ],
      sourceweft: {
        hitlInterruptId: "0123456789abcdef0123456789abcdef",
        connectorActions: [
          {
            actionRunId: "action-1",
            connectorId: "connector-1",
            toolName: "delete_notion_page",
          },
        ],
      },
    },
  });
});

test("run-scoped confirmations use the active run assistant message", () => {
  const oldTurnVersion = createVersion("assistant-old-edit", {
    confirmationId: "old-action",
    threadRunId: "run-old",
  });
  const latestTurnVersion = createVersion("assistant-latest", {
    confirmationId: "latest-action",
    threadRunId: "run-latest",
  });
  const lookup = getToolConfirmationItemsForRun({
    activeThreadRun: {
      assistantMessageId: "assistant-old-edit",
      id: "run-old",
      status: "waiting_for_approval",
    },
    assistantVersionById: createAssistantVersionIndex([
      {
        branchIndex: 1,
        groupId: "assistant:old",
        version: oldTurnVersion,
      },
      {
        groupId: "assistant:latest",
        version: latestTurnVersion,
      },
    ]),
  });

  assert.deepEqual(
    lookup.items.map((item) => item.confirmation.id),
    ["old-action"],
  );
  assert.equal(lookup.reason, "found");
  assert.equal(lookup.items[0]?.assistantMessageId, "assistant-old-edit");
});

test("live stream confirmations are available before persisted message lookup", () => {
  const item = createConfirmationItem("action-live", {
    threadRunId: "run-live",
  });
  const lookup = getLiveToolConfirmationItemsForRun({
    activeThreadRun: {
      assistantMessageId: "assistant-live",
      id: "run-live",
      idempotencyKey: "run-key-live",
      status: "waiting_for_approval",
    },
    signal: {
      id: "signal-live",
      assistantMessageId: "assistant-live",
      liveConfirmations: [
        {
          confirmation: item.confirmation,
          toolCall: item.toolCall,
        },
      ],
      runKey: "run-key-live",
      threadRunId: "run-live",
    },
  });

  assert.deepEqual(
    lookup.map((pending) => pending.confirmation.id),
    ["action-live"],
  );
  assert.equal(lookup[0]?.assistantMessageId, "assistant-live");
  assert.equal(lookup[0]?.threadRunId, "run-live");
});

test("live stream confirmations are scoped to the active run", () => {
  const item = createConfirmationItem("action-live");
  const lookup = getLiveToolConfirmationItemsForRun({
    activeThreadRun: {
      assistantMessageId: "assistant-current",
      id: "run-current",
      idempotencyKey: "run-key-current",
      status: "waiting_for_approval",
    },
    signal: {
      id: "signal-old",
      assistantMessageId: "assistant-old",
      liveConfirmations: [
        {
          confirmation: item.confirmation,
          toolCall: item.toolCall,
        },
      ],
      runKey: "run-key-old",
      threadRunId: "run-old",
    },
  });

  assert.deepEqual(lookup, []);
});

test("live stream confirmations require explicit run identity", () => {
  const item = createConfirmationItem("action-live");
  const signalWithoutRunIdentity = {
    id: "signal-live",
    assistantMessageId: "assistant-current",
    liveConfirmations: [
      {
        confirmation: item.confirmation,
        toolCall: item.toolCall,
      },
    ],
  } as unknown as ToolConfirmationInterventionSignal;

  const lookup = getLiveToolConfirmationItemsForRun({
    activeThreadRun: {
      assistantMessageId: "assistant-current",
      id: "run-current",
      idempotencyKey: "run-key-current",
      status: "waiting_for_approval",
    },
    signal: signalWithoutRunIdentity,
  });

  assert.deepEqual(lookup, []);
  assert.equal(
    hasLiveToolConfirmationSignalForRun({
      activeThreadRun: {
        assistantMessageId: "assistant-current",
        id: "run-current",
        idempotencyKey: "run-key-current",
        status: "waiting_for_approval",
      },
      signal: signalWithoutRunIdentity,
    }),
    false,
  );
});

test("live stream confirmations can match by durable run key before thread run id is available", () => {
  const item = createConfirmationItem("action-live");
  const lookup = getLiveToolConfirmationItemsForRun({
    activeThreadRun: {
      assistantMessageId: "assistant-current",
      idempotencyKey: "run-key-current",
      status: "waiting_for_approval",
    },
    signal: {
      id: "signal-live",
      assistantMessageId: "assistant-current",
      liveConfirmations: [
        {
          confirmation: item.confirmation,
          toolCall: item.toolCall,
        },
      ],
      runKey: "run-key-current",
      threadRunId: null,
    },
  });

  assert.deepEqual(
    lookup.map((pending) => pending.confirmation.id),
    ["action-live"],
  );
  assert.equal(
    hasLiveToolConfirmationSignalForRun({
      activeThreadRun: {
        assistantMessageId: "assistant-current",
        idempotencyKey: "run-key-current",
        status: "waiting_for_approval",
      },
      signal: {
        id: "signal-live",
        assistantMessageId: "assistant-current",
        liveConfirmations: [
          {
            confirmation: item.confirmation,
            toolCall: item.toolCall,
          },
        ],
        runKey: "run-key-current",
        threadRunId: null,
      },
    }),
    true,
  );
});

test("empty live stream confirmation signals are ignored", () => {
  const signal = {
    id: "signal-live-empty",
    assistantMessageId: "assistant-current",
    liveConfirmations: [],
    runKey: "run-key-current",
    threadRunId: null,
  };

  assert.equal(
    hasLiveToolConfirmationSignalForRun({
      activeThreadRun: {
        assistantMessageId: "assistant-current",
        idempotencyKey: "run-key-current",
        status: "waiting_for_approval",
      },
      signal,
    }),
    false,
  );
  assert.deepEqual(
    getLiveToolConfirmationItemsForRun({
      activeThreadRun: {
        assistantMessageId: "assistant-current",
        idempotencyKey: "run-key-current",
        status: "waiting_for_approval",
      },
      signal,
    }),
    [],
  );
});

test("run-scoped confirmations return empty when waiting run lacks assistant message", () => {
  const lookup = getToolConfirmationItemsForRun({
    activeThreadRun: {
      id: "run-1",
      status: "waiting_for_approval",
    },
    assistantVersionById: createAssistantVersionIndex([
      {
        groupId: "assistant:latest",
        version: createVersion("assistant-latest"),
      },
    ]),
  });

  assert.deepEqual(lookup.items, []);
  assert.equal(lookup.reason, "missing_assistant_message");
});

test("run-scoped confirmations return empty when assistant message is missing locally", () => {
  const lookup = getToolConfirmationItemsForRun({
    activeThreadRun: {
      assistantMessageId: "assistant-missing",
      id: "run-1",
      status: "waiting_for_approval",
    },
    assistantVersionById: createAssistantVersionIndex([
      {
        groupId: "assistant:latest",
        version: createVersion("assistant-latest"),
      },
    ]),
  });

  assert.deepEqual(lookup.items, []);
  assert.equal(lookup.reason, "assistant_message_not_found");
  assert.equal(lookup.assistantMessageId, "assistant-missing");
});

test("cancelled assistant versions do not expose pending confirmations", () => {
  const lookup = getToolConfirmationItemsForRun({
    activeThreadRun: {
      assistantMessageId: "assistant-1",
      id: "run-1",
      status: "waiting_for_approval",
    },
    assistantVersionById: createAssistantVersionIndex([
      {
        groupId: "assistant:assistant-1",
        version: {
          ...createVersion("assistant-1"),
          isCancelled: true,
          threadRun: {
            id: "run-1",
            status: "cancelled",
          },
        },
      },
    ]),
  });

  assert.deepEqual(lookup.items, []);
  assert.equal(lookup.reason, "found");
});

test("visible confirmations are hidden after their confirmation id resolves", () => {
  const visible = getVisibleToolConfirmationItems(
    [createConfirmationItem("action-1"), createConfirmationItem("action-2")],
    [{ confirmationId: "action-1", decision: "approve" }],
  );

  assert.deepEqual(
    visible.map((item) => item.confirmation.id),
    ["action-2"],
  );
});

test("composer stays available for approval runs with no visible pending confirmation", () => {
  assert.equal(
    shouldLockComposerForApproval({
      isWaitingForApproval: true,
      pendingConfirmationCount: 0,
    }),
    false,
  );
  assert.equal(
    shouldLockComposerForApproval({
      isWaitingForApproval: true,
      pendingConfirmationCount: 1,
    }),
    true,
  );
});

test("composer stays available for stale waiting runs without pending confirmation", () => {
  assert.equal(
    shouldLockComposerForRun({
      isStreaming: true,
      isWaitingForApproval: true,
      pendingConfirmationCount: 0,
    }),
    false,
  );
  assert.equal(
    shouldLockComposerForRun({
      isStreaming: true,
      isWaitingForApproval: true,
      pendingConfirmationCount: 1,
    }),
    true,
  );
});

test("composer lock keeps streaming fallback when execution state is idle", () => {
  assert.equal(
    shouldLockComposerForRun({
      chatExecutionState: "idle",
      isStreaming: true,
      isWaitingForApproval: false,
      pendingConfirmationCount: 0,
    }),
    true,
  );
});

test("composer lock follows active execution states when provided", () => {
  assert.equal(
    shouldLockComposerForRun({
      chatExecutionState: "executing",
      isStreaming: false,
      isWaitingForApproval: false,
      pendingConfirmationCount: 0,
    }),
    true,
  );
  assert.equal(
    shouldLockComposerForRun({
      chatExecutionState: "waiting_for_approval",
      isStreaming: false,
      isWaitingForApproval: false,
      pendingConfirmationCount: 0,
    }),
    true,
  );
  assert.equal(
    shouldLockComposerForRun({
      chatExecutionState: "stopping",
      isStreaming: false,
      isWaitingForApproval: false,
      pendingConfirmationCount: 0,
    }),
    true,
  );
});

test("composer lock blocks while background tool work is active", () => {
  assert.equal(
    shouldLockComposerForRun({
      chatExecutionState: "idle",
      hasActivelyRunningToolWork: true,
      isStreaming: false,
      isWaitingForApproval: false,
      pendingConfirmationCount: 0,
    }),
    true,
  );
  assert.equal(
    shouldLockComposerForRun({
      chatExecutionState: "idle",
      hasActivelyRunningToolWork: false,
      isStreaming: false,
      isWaitingForApproval: false,
      pendingConfirmationCount: 0,
    }),
    false,
  );
});

test("resolved approval requests are not treated as actively running tool calls", () => {
  const item = createConfirmationItem("action-1");
  assert.equal(
    isToolCallActivelyRunning({
      resolvedConfirmationIds: new Set(["action-1"]),
      toolCall: {
        ...item.toolCall,
        output: item.confirmation,
      },
    }),
    false,
  );
});

test("pending approval requests are treated as active tool calls", () => {
  const item = createConfirmationItem("action-1");
  assert.equal(
    isToolCallActivelyRunning({
      toolCall: {
        ...item.toolCall,
        output: item.confirmation,
      },
    }),
    true,
  );
});

test("tool approval resumes combine every decision in confirmation order", () => {
  const resolutions: ToolConfirmationResolution[] = [
    {
      confirmationId: "action-1",
      decision: "approve",
      resume: {
        decisions: [{ type: "approve" }],
        sourceweft: {
          hitlInterruptId: "0123456789abcdef0123456789abcdef",
          connectorActions: [
            {
              actionRunId: "action-1",
              connectorId: "connector-1",
              toolName: "delete_notion_page",
            },
          ],
        },
      },
    },
    {
      confirmationId: "action-2",
      decision: "reject",
      resume: {
        decisions: [{ type: "reject", message: "Skip this one." }],
      },
    },
  ];

  assert.deepEqual(combineToolApprovalResumes(resolutions), {
    decisions: [
      { type: "approve" },
      { type: "reject", message: "Skip this one." },
    ],
    sourceweft: {
      hitlInterruptId: "0123456789abcdef0123456789abcdef",
      connectorActions: [
        {
          actionRunId: "action-1",
          connectorId: "connector-1",
          toolName: "delete_notion_page",
        },
      ],
    },
  });
});

test("tool approval resume keeps earlier decisions after resolved cards leave the pending list", () => {
  const firstResolution: ToolConfirmationResolution = {
    confirmationId: "action-1",
    decision: "approve",
    resume: {
      decisions: [{ type: "approve" }],
      sourceweft: {
        connectorActions: [
          {
            actionRunId: "action-1",
            connectorId: "connector-1",
            toolName: "delete_notion_page",
          },
        ],
      },
    },
  };
  const secondResolution: ToolConfirmationResolution = {
    confirmationId: "action-2",
    decision: "approve",
    resume: {
      decisions: [{ type: "approve" }],
      sourceweft: {
        connectorActions: [
          {
            actionRunId: "action-2",
            connectorId: "connector-1",
            toolName: "delete_notion_page",
          },
        ],
      },
    },
  };

  const ordered = orderToolConfirmationResolutions({
    confirmationIds: updateToolConfirmationOrder(
      ["action-1", "action-2"],
      [createConfirmationItem("action-2")],
    ),
    resolutions: [firstResolution, secondResolution],
  });

  assert.deepEqual(
    ordered.map((resolution) => resolution.confirmationId),
    ["action-1", "action-2"],
  );
  assert.deepEqual(combineToolApprovalResumes(ordered), {
    decisions: [{ type: "approve" }, { type: "approve" }],
    sourceweft: {
      connectorActions: [
        {
          actionRunId: "action-1",
          connectorId: "connector-1",
          toolName: "delete_notion_page",
        },
        {
          actionRunId: "action-2",
          connectorId: "connector-1",
          toolName: "delete_notion_page",
        },
      ],
    },
  });
});

test("tool approval resumes merge sandbox action refs from every decision", () => {
  assert.deepEqual(
    combineToolApprovalResumes([
      {
        confirmationId: "sandbox-1",
        decision: "approve",
        resume: {
          decisions: [{ type: "approve" }],
          sourceweft: {
            sandboxActions: [
              {
                requestJson: { command: "npm test" },
                toolCallId: "call-sandbox-1",
                toolName: "execute",
              },
            ],
          },
        },
      },
      {
        confirmationId: "sandbox-2",
        decision: "approve",
        resume: {
          decisions: [{ type: "approve" }],
          sourceweft: {
            sandboxActions: [
              {
                requestJson: { command: "npm run build" },
                toolCallId: "call-sandbox-2",
                toolName: "execute",
              },
            ],
          },
        },
      },
    ]),
    {
      decisions: [{ type: "approve" }, { type: "approve" }],
      sourceweft: {
        sandboxActions: [
          {
            requestJson: { command: "npm test" },
            toolCallId: "call-sandbox-1",
            toolName: "execute",
          },
          {
            requestJson: { command: "npm run build" },
            toolCallId: "call-sandbox-2",
            toolName: "execute",
          },
        ],
      },
    },
  );
});

test("tool approval resume stays blocked when any decided confirmation lacks resume data", () => {
  assert.equal(
    combineToolApprovalResumes([
      {
        confirmationId: "action-1",
        decision: "approve",
        resume: {
          decisions: [{ type: "approve" }],
        },
      },
      {
        confirmationId: "action-2",
        decision: "approve",
      },
    ]),
    null,
  );
});

test("tool approval resume ignores stale confirmation markers", () => {
  assert.deepEqual(
    combineToolApprovalResumes([
      {
        confirmationId: "action-1",
        decision: "reject",
        stale: true,
      },
      {
        confirmationId: "action-2",
        decision: "approve",
        resume: {
          decisions: [{ type: "approve" }],
        },
      },
    ]),
    {
      decisions: [{ type: "approve" }],
    },
  );
});

test("tool approval resume preserves HITL interrupt id without connector actions", () => {
  assert.deepEqual(
    combineToolApprovalResumes([
      {
        confirmationId: "action-1",
        decision: "reject",
        resume: {
          decisions: [{ type: "reject", message: "Skip" }],
          sourceweft: {
            hitlInterruptId: "0123456789abcdef0123456789abcdef",
          },
        },
      },
    ]),
    {
      decisions: [{ type: "reject", message: "Skip" }],
      sourceweft: {
        hitlInterruptId: "0123456789abcdef0123456789abcdef",
      },
    },
  );
});

test("tool approval resume preserves sourceweft metadata without interpreting it", () => {
  assert.deepEqual(
    combineToolApprovalResumes([
      {
        confirmationId: "action-1",
        decision: "approve",
        resume: {
          decisions: [{ type: "approve" }],
          sourceweft: {
            hitlInterruptId: "0123456789abcdef0123456789abcdef",
            sourceAssistantMessageId: "assistant-sandbox-execute",
          },
        },
      },
    ]),
    {
      decisions: [{ type: "approve" }],
      sourceweft: {
        hitlInterruptId: "0123456789abcdef0123456789abcdef",
        sourceAssistantMessageId: "assistant-sandbox-execute",
      },
    },
  );
});

test("stopped confirmation markers hide pending confirmations and do not resume", () => {
  const stoppedResolution: ToolConfirmationResolution = {
    confirmationId: "action-1",
    decision: "reject",
    resume: null,
    stopped: true,
  };

  assert.deepEqual(
    getVisibleToolConfirmationItems(
      [createConfirmationItem("action-1")],
      [stoppedResolution],
    ),
    [],
  );
  assert.equal(combineToolApprovalResumes([stoppedResolution]), null);
});

test("expired approval metadata derives terminal confirmation resolutions", () => {
  const version = createVersion("assistant-1", {
    confirmationId: "action-1",
    threadRunStatus: "cancelled",
  });
  const messageGroups: VersionedMessageGroup[] = [
    {
      groupId: "assistant-group",
      latestVersionId: "assistant-1",
      role: "assistant",
      versions: [
        {
          ...version,
          errorCode: "TOOL_APPROVAL_EXPIRED",
        },
      ],
    },
  ];

  const resolutions = deriveTerminalToolConfirmationResolutions({
    messageGroups,
  });

  assert.deepEqual(resolutions, [
    {
      confirmationId: "action-1",
      decision: "reject",
      expired: true,
      resume: null,
    },
  ]);
  assert.deepEqual(
    getVisibleToolConfirmationItems(
      [createConfirmationItem("action-1")],
      resolutions,
    ),
    [],
  );
});

test("cancelled approval metadata derives stopped confirmations, not expired", () => {
  const version = createVersion("assistant-1", {
    confirmationId: "action-1",
    threadRunStatus: "cancelled",
  });
  const messageGroups: VersionedMessageGroup[] = [
    {
      groupId: "assistant-group",
      latestVersionId: "assistant-1",
      role: "assistant",
      versions: [
        {
          ...version,
          errorCode: "CLIENT_CANCELLED",
          isCancelled: true,
        },
      ],
    },
  ];

  assert.deepEqual(
    deriveTerminalToolConfirmationResolutions({ messageGroups }),
    [
      {
        confirmationId: "action-1",
        decision: "reject",
        resume: null,
        stopped: true,
      },
    ],
  );
});

test("terminal approval derivation follows the active visible assistant version", () => {
  const messageGroups: VersionedMessageGroup[] = [
    {
      groupId: "assistant-group",
      latestVersionId: "assistant-2",
      role: "assistant",
      versions: [
        {
          ...createVersion("assistant-1", {
            confirmationId: "action-1",
            threadRunStatus: "cancelled",
          }),
          errorCode: "TOOL_APPROVAL_EXPIRED",
        },
        createVersion("assistant-2", {
          confirmationId: "action-2",
          threadRunStatus: "waiting_for_approval",
        }),
      ],
    },
  ];

  assert.deepEqual(
    deriveTerminalToolConfirmationResolutions({
      activeVersionByGroup: { "assistant-group": 1 },
      messageGroups,
    }),
    [],
  );
  assert.deepEqual(
    deriveTerminalToolConfirmationResolutions({
      activeVersionByGroup: { "assistant-group": 0 },
      messageGroups,
    }).map((resolution) => resolution.confirmationId),
    ["action-1"],
  );
});

test("local confirmation resolutions take precedence over derived terminal metadata", () => {
  const local: ToolConfirmationResolution[] = [
    {
      confirmationId: "action-1",
      decision: "reject",
      resume: null,
      stopped: true,
    },
  ];
  const derived: ToolConfirmationResolution[] = [
    {
      confirmationId: "action-1",
      decision: "reject",
      expired: true,
      resume: null,
    },
    {
      confirmationId: "action-2",
      decision: "reject",
      expired: true,
      resume: null,
    },
  ];

  assert.deepEqual(mergeToolConfirmationResolutions({ derived, local }), [
    local[0],
    derived[1],
  ]);
});

test("stale confirmation response errors are identified by backend error code", () => {
  assert.equal(
    isStaleToolConfirmationResponse({
      code: "CHAT_RUN_NOT_WAITING_FOR_APPROVAL",
    }),
    true,
  );
  assert.equal(
    isStaleToolConfirmationResponse({ code: "CONFIRMATION_NOT_ACTIVE" }),
    true,
  );
  assert.equal(
    isStaleToolConfirmationResponse({ code: "TOOL_APPROVAL_EXPIRED" }),
    false,
  );
  assert.equal(
    isExpiredToolConfirmationResponse({ code: "TOOL_APPROVAL_EXPIRED" }),
    true,
  );
  assert.equal(
    isStaleToolConfirmationResponse({
      code: "CONFIRMATION_ASSISTANT_MESSAGE_MISMATCH",
    }),
    false,
  );
});
