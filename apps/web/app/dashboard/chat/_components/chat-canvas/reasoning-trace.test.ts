import assert from "node:assert/strict";
import { test } from "vitest";
import {
  compareReasoningTraceTimelineItems,
  getConnectorToolDisplayLabel,
  getResolvedToolConfirmationMessage,
  getToolApprovalDisplayLabel,
  getToolCallDetailParts,
  getReasoningTraceTitle,
  isToolConfirmationResolved,
  isReasoningTraceThinking,
  shouldShowGeneratedPresentationItem,
} from "./reasoning-trace-state";
import {
  getTodoListTraceItems,
  isTodoListTraceStep,
} from "./reasoning-trace-todos";
import { formatThoughtDuration } from "./duration-format";
import type { ToolConfirmationRequestOutput } from "./tool-confirmation-state";

test("completed tool-only traces do not show thinking title", () => {
  assert.equal(
    getReasoningTraceTitle({
      hasModelReasoning: false,
      hasTraceItems: true,
      isStreaming: false,
    }),
    "Completed",
  );
});

test("pending confirmations keep the trace in thinking state", () => {
  assert.equal(
    getReasoningTraceTitle({
      hasModelReasoning: false,
      hasTraceItems: true,
      isStreaming: false,
      waitingForConfirmation: true,
    }),
    "Thinking · Waiting for confirmation",
  );
});

test("streaming model reasoning remains in the active thinking state", () => {
  assert.equal(
    getReasoningTraceTitle({
      hasModelReasoning: true,
      hasRunningToolCall: false,
      hasTraceItems: true,
      isStreaming: true,
      reasoningDurationMs: 12_000,
    }),
    "Thinking...",
  );
  assert.equal(
    isReasoningTraceThinking({
      hasActiveStep: false,
      hasRunningToolCall: false,
      hasTraceItems: true,
      isStreaming: true,
      waitingForConfirmation: false,
    }),
    true,
  );
});

test("active presentation publishing step keeps trace in thinking state", () => {
  assert.equal(
    getReasoningTraceTitle({
      activeStep: {
        id: "presentation-generation",
        title: "Publishing presentation",
        status: "in_progress",
        items: ["Preparing presentation artifact"],
        sequence: 1,
      },
      hasModelReasoning: true,
      hasTraceItems: true,
      isStreaming: false,
      reasoningDurationMs: 42_000,
    }),
    "Thinking · Publishing presentation",
  );
});

test("async background tool work keeps thinking title without hardcoding video copy", () => {
  assert.equal(
    getReasoningTraceTitle({
      hasModelReasoning: false,
      hasRunningToolCall: true,
      hasTraceItems: true,
      isStreaming: false,
      latestDisplayStep: {
        id: "video-presentation-generation",
        title: "Building video presentation",
        status: "completed",
        items: [],
        sequence: 2,
      },
    }),
    "Thinking · Working...",
  );
  assert.equal(
    getReasoningTraceTitle({
      hasModelReasoning: false,
      hasRunningToolCall: true,
      hasTraceItems: true,
      isStreaming: false,
      latestDisplayStep: {
        id: "sandbox-execute",
        title: "Running command",
        status: "in_progress",
        items: [],
        sequence: 2,
      },
    }),
    "Thinking · Running command",
  );
});

test("sandbox presentation publisher card waits for completed artifact URL", () => {
  assert.equal(
    shouldShowGeneratedPresentationItem({
      fileUrl: null,
      isArtifactPublisher: true,
      isVideoPresentation: false,
      previewArtifact: null,
      status: "running",
    }),
    false,
  );
  assert.equal(
    shouldShowGeneratedPresentationItem({
      fileUrl: null,
      isArtifactPublisher: true,
      isVideoPresentation: false,
      previewArtifact: null,
      status: "approval_requested",
    }),
    false,
  );
  assert.equal(
    shouldShowGeneratedPresentationItem({
      fileUrl: "/artifact-preview?artifactId=artifact-1",
      isArtifactPublisher: true,
      isVideoPresentation: false,
      previewArtifact: null,
      status: "completed",
    }),
    true,
  );
  assert.equal(
    shouldShowGeneratedPresentationItem({
      fileUrl: null,
      isArtifactPublisher: true,
      isVideoPresentation: false,
      previewArtifact: null,
      status: "completed",
    }),
    false,
  );
});

test("todo list trace steps are detected from generic display metadata", () => {
  assert.equal(
    isTodoListTraceStep({
      id: "deepagents:todos",
      title: "Task plan",
      status: "in_progress",
      items: [],
      metadata: {
        display: "todo_list",
        visibility: "user",
      },
    }),
    true,
  );

  assert.equal(
    isTodoListTraceStep({
      id: "deepagents:todos",
      title: "Task plan",
      status: "in_progress",
      items: [],
      metadata: {
        display: "todo_list",
      },
    }),
    false,
  );
});

test("todo list trace items normalize public todo metadata", () => {
  assert.deepEqual(
    getTodoListTraceItems({
      todos: [
        {
          content: "Plan content structure",
          description: "Outline the main sections",
          id: "todo-1",
          status: "completed",
        },
        {
          content: "Generate draft",
          status: "in_progress",
        },
        {
          title: "Review final output",
          status: "pending",
        },
        {
          content: "Ignore unsupported status",
          status: "blocked",
        },
      ],
    }),
    [
      {
        content: "Plan content structure",
        description: "Outline the main sections",
        id: "todo-1",
        status: "completed",
      },
      {
        content: "Generate draft",
        id: "1:Generate draft",
        status: "in_progress",
      },
      {
        content: "Review final output",
        id: "2:Review final output",
        status: "pending",
      },
      {
        content: "Ignore unsupported status",
        id: "3:Ignore unsupported status",
        status: "pending",
      },
    ],
  );
});

test("completed model reasoning shows elapsed thought duration", () => {
  assert.equal(
    getReasoningTraceTitle({
      hasModelReasoning: true,
      hasRunningToolCall: false,
      hasTraceItems: true,
      isStreaming: false,
      reasoningDurationMs: 12_000,
    }),
    "Thought for 12s",
  );
  assert.equal(
    isReasoningTraceThinking({
      hasActiveStep: false,
      hasRunningToolCall: false,
      hasTraceItems: true,
      isStreaming: false,
      waitingForConfirmation: false,
    }),
    false,
  );
});

test("thought durations use compact elapsed time", () => {
  assert.equal(formatThoughtDuration(0), "Thought for 1s");
  assert.equal(formatThoughtDuration(999), "Thought for 1s");
  assert.equal(formatThoughtDuration(42_000), "Thought for 42s");
  assert.equal(formatThoughtDuration(60_000), "Thought for 1m");
  assert.equal(formatThoughtDuration(92_000), "Thought for 1m32s");
  assert.equal(formatThoughtDuration(1_375_000), "Thought for 22m55s");
  assert.equal(formatThoughtDuration(undefined), "Thought for a few seconds");
});

test("completed steps remain thinking while the message version is streaming", () => {
  assert.equal(
    getReasoningTraceTitle({
      latestDisplayStep: {
        id: "search",
        title: "Searching the web",
        status: "completed",
        items: [],
        sequence: 1,
      },
      hasModelReasoning: true,
      hasRunningToolCall: false,
      hasTraceItems: true,
      isStreaming: true,
      reasoningDurationMs: 12_000,
    }),
    "Thinking...",
  );
});

test("empty streaming trace shows initial thinking state", () => {
  assert.equal(
    isReasoningTraceThinking({
      hasActiveStep: false,
      hasRunningToolCall: false,
      hasTraceItems: false,
      isStreaming: true,
      waitingForConfirmation: false,
    }),
    true,
  );
});

test("timeline sorting follows sequence for follow-up reasoning", () => {
  const items = [
    {
      kind: "model-reasoning" as const,
      key: "model-reasoning:after-tool",
      originalIndex: 0,
      phase: "after_tool" as const,
      sequence: 5,
      text: "Found 2 Notion pages related to the request.",
      toolCallId: "tool-1",
    },
    {
      kind: "tool" as const,
      key: "tool:tool-1",
      originalIndex: 0,
      sequence: 4,
      toolCall: {
        id: "tool-1",
        tool: "search_notion_pages",
        input: {},
        output: null,
        latencyMs: 1215,
        status: "completed" as const,
        error: null,
        sequence: 4,
      },
    },
    {
      kind: "step" as const,
      key: "step:verify",
      originalIndex: 0,
      sequence: 5,
      step: {
        id: "verify",
        title: "Checking citations",
        status: "completed" as const,
        items: [],
        sequence: 5,
      },
    },
  ];

  assert.deepEqual(
    [...items]
      .sort(compareReasoningTraceTimelineItems)
      .map((item) => item.key),
    ["tool:tool-1", "model-reasoning:after-tool", "step:verify"],
  );
});

test("timeline sorting does not move reasoning by toolCallId", () => {
  const items = [
    {
      kind: "model-reasoning" as const,
      key: "model-reasoning:initial",
      originalIndex: 0,
      phase: "initial" as const,
      sequence: 4,
      text: "I need to inspect the page first.",
      toolCallId: "tool-1",
    },
    {
      kind: "tool" as const,
      key: "tool:tool-1",
      originalIndex: 0,
      sequence: 4,
      toolCall: {
        id: "tool-1",
        tool: "search_notion_pages",
        input: {},
        output: null,
        latencyMs: 1215,
        status: "completed" as const,
        error: null,
        sequence: 4,
      },
    },
  ];

  assert.deepEqual(
    [...items]
      .sort(compareReasoningTraceTimelineItems)
      .map((item) => item.key),
    ["model-reasoning:initial", "tool:tool-1"],
  );
});

test("timeline sorting keeps interrupted reasoning as separate records", () => {
  const items = [
    {
      kind: "model-reasoning" as const,
      key: "model-reasoning:before-tool",
      originalIndex: 0,
      sequence: 1,
      text: "Need to search Notion.",
    },
    {
      kind: "model-reasoning" as const,
      key: "model-reasoning:after-tool",
      originalIndex: 1,
      sequence: 3,
      text: "Found the relevant page.",
      toolCallId: "tool-1",
    },
    {
      kind: "tool" as const,
      key: "tool:tool-1",
      originalIndex: 0,
      sequence: 2,
      toolCall: {
        id: "tool-1",
        tool: "search_notion_pages",
        input: {},
        output: null,
        latencyMs: 1215,
        status: "completed" as const,
        error: null,
        sequence: 2,
      },
    },
  ];

  const sorted = [...items].sort(compareReasoningTraceTimelineItems);

  assert.deepEqual(
    sorted.map((item) => item.key),
    [
      "model-reasoning:before-tool",
      "tool:tool-1",
      "model-reasoning:after-tool",
    ],
  );
  const afterToolItem = sorted[2];
  assert.ok(afterToolItem);
  assert.equal(
    afterToolItem.kind === "model-reasoning" && afterToolItem.text,
    "Found the relevant page.",
  );
});

test("connector tool details include canonical tool and action names", () => {
  assert.deepEqual(
    getToolCallDetailParts({
      id: "tool-1",
      tool: "search_notion_pages",
      input: {},
      output: {
        type: "connector_tool_result",
        connector: "notion",
        toolName: "search_notion_pages",
        actionType: "notion.page.find",
        query: "服务器",
        resultCount: 2,
      },
      latencyMs: 1196,
      status: "completed",
      error: null,
      sequence: 4,
    }),
    [
      "status: completed",
      "tool: search_notion_pages",
      "action: notion.page.find",
      "2 results",
      "time: 1196ms",
    ],
  );
});

test("execute tool details include display-safe command", () => {
  assert.deepEqual(
    getToolCallDetailParts({
      id: "tool-execute",
      tool: "execute",
      input: { command: "pnpm test" },
      output: { output: "ok", exitCode: 0, truncated: false },
      latencyMs: 42,
      status: "completed",
      error: null,
      sequence: 1,
    }),
    ["status: completed", "command: pnpm test", "time: 42ms"],
  );

  assert.deepEqual(
    getToolCallDetailParts({
      id: "tool-execute",
      tool: "execute",
      input: { command: "printf 'a\nb'\t\u0001" },
      output: null,
      latencyMs: null,
      status: "error",
      error: "failed",
      sequence: 1,
    }),
    ["status: error", "command: printf 'a\\nb'\\t\\u0001"],
  );

  assert.deepEqual(
    getToolCallDetailParts({
      id: "tool-execute",
      tool: "execute",
      input: { command: "   " },
      output: null,
      latencyMs: null,
      status: "completed",
      error: null,
      sequence: 1,
    }),
    ["status: completed"],
  );

  assert.deepEqual(
    getToolCallDetailParts({
      id: "tool-execute",
      tool: "execute",
      input: {},
      output: null,
      latencyMs: null,
      status: "completed",
      error: null,
      sequence: 1,
    }),
    ["status: completed"],
  );

  const longCommand = `node ${"x".repeat(300)}`;
  const longCommandDetails = getToolCallDetailParts({
    id: "tool-execute",
    tool: "execute",
    input: { command: longCommand },
    output: null,
    latencyMs: null,
    status: "completed",
    error: null,
    sequence: 1,
  });
  assert.equal(longCommandDetails[1]?.startsWith("command: node "), true);
  assert.equal(longCommandDetails[1]?.endsWith("..."), true);
  assert.ok((longCommandDetails[1]?.length ?? 0) <= 250);
});

test("sandbox result-level failures render as error details", () => {
  assert.deepEqual(
    getToolCallDetailParts({
      id: "tool-prepare",
      tool: "prepare_sandbox_workspace",
      input: {},
      output: {
        ok: false,
        type: "sandbox_prepare_error",
        status: "failed",
        code: "ENOENT",
        message: "ENOENT: no such file",
        recoverable: true,
      },
      latencyMs: null,
      status: "completed",
      error: null,
      sequence: 1,
    })[0],
    "status: error",
  );
});

test("approval replay trace distinguishes recorded approval, failed execution, and next pending approval", () => {
  const approvalRecorded = {
    id: "delete-page:approval-recorded",
    tool: "delete_notion_page",
    input: {},
    output: {
      type: "tool_confirmation_request",
      schemaVersion: 1,
      id: "action-1",
      domain: "connector",
      subject: {
        label: "Notion",
        provider: "notion",
        connectorId: "connector-1",
      },
      action: {
        type: "notion.page.trash",
        toolName: "delete_notion_page",
        label: "Delete",
        riskLevel: "high",
        status: "approved",
        requiresApproval: true,
      },
      preview: {
        title: "Delete Notion page: Workspace Root",
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
          actionRunId: "action-1",
        },
      },
      status: "approved",
      userMessage: "Approval recorded.",
    },
    latencyMs: 0,
    status: "completed" as const,
    error: null,
    sequence: 2,
  };
  const approvedFailure = {
    id: "delete-page",
    tool: "delete_notion_page",
    input: {},
    output: null,
    latencyMs: 1750,
    status: "error" as const,
    error: "Archiving workspace level pages via API not supported.",
    sequence: 2,
    approvalState: "approved" as const,
  };
  const nextPending = {
    id: "delete-page-2",
    tool: "delete_notion_page",
    input: {},
    output: {
      ...approvalRecorded.output,
      id: "action-2",
      action: {
        ...approvalRecorded.output.action,
        status: "proposed",
      },
      execution: {
        ...approvalRecorded.output.execution,
        executor: {
          kind: "connector_action_run",
          connectorId: "connector-1",
          actionRunId: "action-2",
        },
      },
      status: "proposed",
    },
    latencyMs: 0,
    status: "approval_requested" as const,
    error: null,
    sequence: 4,
  };

  assert.deepEqual(
    [approvalRecorded, approvedFailure, nextPending].map((toolCall) =>
      getToolApprovalDisplayLabel(toolCall),
    ),
    [
      "Delete Notion Page approval recorded",
      "Delete Notion Page approved action failed",
      "Delete Notion Page waiting for approval",
    ],
  );
  assert.deepEqual(
    [approvalRecorded, approvedFailure, nextPending].map(
      (toolCall) => getToolCallDetailParts(toolCall)[0],
    ),
    [
      "status: approval recorded",
      "status: approved action failed",
      "status: waiting for approval",
    ],
  );
});

test("completed approved connector actions keep approval details visible", () => {
  assert.deepEqual(
    getToolCallDetailParts({
      id: "delete-page",
      tool: "delete_notion_page",
      input: {},
      output: {
        type: "connector_tool_result",
        connector: "notion",
        toolName: "delete_notion_page",
        actionType: "notion.page.trash",
      },
      latencyMs: 9660,
      status: "completed",
      error: null,
      sequence: 4,
      approvalState: "approved",
      approvalConfirmationId: "action-1",
    }),
    [
      "status: completed",
      "approval: approved",
      "confirmation: action-1",
      "tool: delete_notion_page",
      "action: notion.page.trash",
      "time: 9660ms",
    ],
  );
});

test("video presentation details use pipeline elapsed time, not tool latency", () => {
  const artifactId = "artifact-vp-1";
  const startedAt = new Date(Date.now() - 65_000).toISOString();
  const artifactStatuses = new Map([
    [
      artifactId,
      {
        id: artifactId,
        status: "running",
        createdAt: startedAt,
        completedAt: null,
        updatedAt: new Date().toISOString(),
        payloadJson: {
          generation: {
            status: "running",
            stage: "planning_storyboard",
            progress: 10,
            pipelineSteps: [
              {
                id: "planning_storyboard",
                label: "Planning storyboard",
                status: "running",
                startedAt,
              },
            ],
          },
        },
      } as never,
    ],
  ]);

  const parts = getToolCallDetailParts(
    {
      id: "tool-vp",
      tool: "generate_video_presentation",
      input: {},
      output: {
        type: "video_presentation_processing_result",
        artifact_id: artifactId,
        status: "running",
        stage: "planning_storyboard",
        progress: 0,
      },
      latencyMs: 211,
      status: "completed",
      error: null,
      sequence: 1,
    },
    undefined,
    null,
    artifactStatuses,
  );

  assert.ok(parts.includes("status: generating"));
  assert.ok(parts.some((part) => /^time: \d+m?\d*s$/.test(part)));
  assert.ok(!parts.includes("time: 211ms"));
});

test("connector action labels stay action-oriented across rejected and completed states", () => {
  const rejected = {
    id: "delete-page:rejected",
    tool: "delete_notion_page",
    input: {},
    output: {
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
        type: "notion.page.trash",
        toolName: "delete_notion_page",
        label: "Delete",
        riskLevel: "high",
        status: "rejected",
        requiresApproval: true,
      },
      preview: {
        title: "Delete Notion page: 测试",
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
          actionRunId: "confirmation-1",
        },
      },
      status: "rejected",
      userMessage: "Approval rejected. The action was not run.",
    },
    latencyMs: 0,
    status: "completed" as const,
    error: null,
    sequence: 2,
    approvalState: "rejected" as const,
    approvalConfirmationId: "confirmation-1",
  };
  const completed = {
    id: "delete-page:completed",
    tool: "delete_notion_page",
    input: {},
    output: {
      type: "connector_tool_result",
      connector: "notion",
      toolName: "delete_notion_page",
      actionType: "notion.page.trash",
      pageId: "page-1",
    },
    latencyMs: 2030,
    status: "completed" as const,
    error: null,
    sequence: 4,
    approvalState: "approved" as const,
    approvalConfirmationId: "confirmation-2",
  };

  assert.equal(
    getToolApprovalDisplayLabel(rejected),
    "Delete Notion Page approval rejected",
  );
  assert.equal(
    getConnectorToolDisplayLabel(completed),
    "Delete Notion Page completed",
  );
});

test("persisted approved confirmations are resolved without local resolution state", () => {
  const approvedConfirmation: ToolConfirmationRequestOutput = {
    type: "tool_confirmation_request",
    schemaVersion: 1,
    id: "action-1",
    domain: "connector",
    subject: {
      label: "Notion",
      provider: "notion",
      connectorId: "connector-1",
    },
    action: {
      type: "notion.page.trash",
      toolName: "delete_notion_page",
      label: "Delete",
      riskLevel: "high",
      status: "approved",
      requiresApproval: true,
    },
    preview: {
      title: "Delete Notion page: Workspace Root",
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
        actionRunId: "action-1",
      },
    },
    status: "approved",
    userMessage: "Approval recorded.",
  };

  assert.equal(
    isToolConfirmationResolved({
      confirmation: approvedConfirmation,
      confirmationResolution: null,
    }),
    true,
  );
  assert.equal(
    getResolvedToolConfirmationMessage({
      confirmation: approvedConfirmation,
      confirmationResolution: null,
    }),
    "Approval recorded. The action may now run.",
  );
});

test("stopped confirmations are shown as stopped instead of waiting", () => {
  const pendingConfirmation: ToolConfirmationRequestOutput = {
    type: "tool_confirmation_request",
    schemaVersion: 1,
    id: "action-1",
    domain: "connector",
    subject: {
      label: "Notion",
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
      title: "Delete Notion page: Workspace Root",
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
        actionRunId: "action-1",
      },
    },
    status: "proposed",
    userMessage: "Waiting for confirmation.",
  };
  const resolution = {
    confirmationId: "action-1",
    decision: "reject" as const,
    resume: null,
    stopped: true,
  };

  assert.equal(
    isToolConfirmationResolved({
      confirmation: pendingConfirmation,
      confirmationResolution: resolution,
    }),
    true,
  );
  assert.equal(
    getResolvedToolConfirmationMessage({
      confirmation: pendingConfirmation,
      confirmationResolution: resolution,
    }),
    "Approval stopped. The action was not run.",
  );
  assert.equal(
    getToolApprovalDisplayLabel(
      {
        id: "tool-1",
        tool: "delete_notion_page",
        input: {},
        output: pendingConfirmation,
        latencyMs: 0,
        status: "approval_requested",
        error: null,
      },
      resolution,
    ),
    "Delete Notion Page approval stopped",
  );
});

test("expired confirmations are shown as unhandled expired decisions", () => {
  const pendingConfirmation: ToolConfirmationRequestOutput = {
    type: "tool_confirmation_request",
    schemaVersion: 1,
    id: "action-1",
    domain: "connector",
    subject: {
      label: "Notion",
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
      title: "Delete Notion page: Workspace Root",
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
        actionRunId: "action-1",
      },
    },
    status: "proposed",
    userMessage: "Waiting for confirmation.",
  };
  const resolution = {
    confirmationId: "action-1",
    decision: "reject" as const,
    expired: true,
    resume: null,
  };

  assert.equal(
    isToolConfirmationResolved({
      confirmation: pendingConfirmation,
      confirmationResolution: resolution,
    }),
    true,
  );
  assert.equal(
    getResolvedToolConfirmationMessage({
      confirmation: pendingConfirmation,
      confirmationResolution: resolution,
    }),
    "Approval expired without a decision. The action was not run.",
  );
  assert.equal(
    getToolApprovalDisplayLabel(
      {
        id: "tool-1",
        tool: "delete_notion_page",
        input: {},
        output: pendingConfirmation,
        latencyMs: 0,
        status: "approval_requested",
        error: null,
      },
      resolution,
    ),
    "Delete Notion Page approval expired",
  );
});
