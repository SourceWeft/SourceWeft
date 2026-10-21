import assert from "node:assert/strict";
import { test } from "vitest";
import type { ToolCallRecord } from "../../_components/chat-canvas/types";
import { buildMessageRenderState } from "../../_components/chat-canvas/message-render-state";
import { getSandboxExecuteView } from "../../_components/chat-canvas/sandbox-tool-result-display";
import type { ChatMessageItem } from "../streaming-assistant-state";
import { buildVersionedMessageGroups } from "./message-groups";
import {
  readMessageAgentRunProgress,
  readMessageAgentRunStop,
} from "../../_components/chat-canvas/agent-run-continuation";
import {
  dropStaleActiveThreadRunMessages,
  findActiveThreadRunMessage,
  findLatestActiveThreadRunMessage,
  hasRenderBlocksMetadata,
  isCompletedArtifactToolCall,
  normalizeToolCallRecord,
  resolveRenderBlocksFromMetadata,
  resolveToolCallsFromMetadata,
  resolveToolCallFromStreamEvent,
  sanitizeClientErrorMessage,
  STREAM_TEXT_INTERRUPTED_KEY,
} from "./message-normalizers";

function createMessage(
  overrides: Partial<ChatMessageItem> & Pick<ChatMessageItem, "id" | "role">,
): ChatMessageItem {
  return {
    content: "",
    contentJson: {},
    parentMessageId: null,
    metadata: {},
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

test("message grouping collapses duplicate message ids before versioning", () => {
  const userMessage = createMessage({
    id: "user-1",
    role: "user",
    content: "Create a Notion page",
  });
  const interruptedAssistant = createMessage({
    id: "assistant-1",
    role: "assistant",
    content: "Waiting for confirmation",
    metadata: {
      userMessageId: "user-1",
      sourceUserMessageId: "user-1",
      finishReason: "tool_confirmation_requested",
    },
  });
  const resumedAssistant = createMessage({
    ...interruptedAssistant,
    content: "Created the Notion page",
    metadata: {
      ...interruptedAssistant.metadata,
      finishReason: "stop",
    },
  });

  const groups = buildVersionedMessageGroups([
    userMessage,
    interruptedAssistant,
    resumedAssistant,
  ]);

  const assistantGroup = groups.find((group) => group.role === "assistant");
  assert.equal(assistantGroup?.versions.length, 1);
  assert.equal(assistantGroup?.versions[0]?.id, "assistant-1");
  assert.equal(assistantGroup?.versions[0]?.content, "Created the Notion page");
});

test("waiting confirmation runs restored from messages carry assistant message id", () => {
  const assistant = createMessage({
    id: "assistant-waiting",
    role: "assistant",
    metadata: {
      threadRun: {
        id: "run-1",
        idempotencyKey: "sourceweft-web-run:run-1",
        status: "waiting_for_approval",
        mode: "send",
      },
    },
  });

  const restored = findLatestActiveThreadRunMessage([assistant]);

  assert.equal(restored?.message.id, "assistant-waiting");
  assert.equal(restored?.run.assistantMessageId, "assistant-waiting");
  assert.equal(restored?.run.status, "waiting_for_approval");
});

test("messages with stale running metadata do not restore without server active run", () => {
  const stalePlaceholder = createMessage({
    id: "assistant-placeholder",
    role: "assistant",
    metadata: {
      threadRun: {
        id: "run-1",
        idempotencyKey: "sourceweft-web-run:run-1",
        status: "running",
        mode: "edit",
      },
    },
  });

  assert.equal(findActiveThreadRunMessage([stalePlaceholder], null), null);
});

test("stale running assistant placeholder is hidden after terminal run message", () => {
  const stalePlaceholder = createMessage({
    id: "assistant-placeholder",
    role: "assistant",
    createdAt: "2026-05-29T15:37:36.434Z",
    metadata: {
      threadRun: {
        id: "run-1",
        idempotencyKey: "sourceweft-web-run:run-1",
        status: "running",
        mode: "send",
      },
    },
  });
  const completedAssistant = createMessage({
    id: "assistant-final",
    role: "assistant",
    content: "Video project created.",
    createdAt: "2026-05-29T15:38:53.195Z",
    metadata: {
      finishReason: "stop",
      threadRun: {
        id: "run-1",
        idempotencyKey: "sourceweft-web-run:run-1",
        status: "completed",
        mode: "send",
      },
    },
  });

  const filtered = dropStaleActiveThreadRunMessages([
    stalePlaceholder,
    completedAssistant,
  ]);

  assert.deepEqual(
    filtered.map((message) => message.id),
    ["assistant-final"],
  );
});

test("server active run restores the matching assistant message", () => {
  const assistant = createMessage({
    id: "assistant-running",
    role: "assistant",
    metadata: {
      threadRun: {
        id: "run-1",
        idempotencyKey: "sourceweft-web-run:run-1",
        status: "running",
        mode: "edit",
      },
    },
  });

  const restored = findActiveThreadRunMessage([assistant], {
    id: "run-1",
    idempotencyKey: "sourceweft-web-run:run-1",
    status: "running",
    mode: "edit",
    userMessageId: "user-1",
    assistantMessageId: null,
  });

  assert.equal(restored?.message.id, "assistant-running");
  assert.equal(restored?.run.assistantMessageId, "assistant-running");
  assert.equal(restored?.run.userMessageId, "user-1");
});

test("error messages are terminal even if thread run metadata is stale", () => {
  const assistant = createMessage({
    id: "assistant-error",
    role: "assistant",
    metadata: {
      isError: true,
      errorCode: "MODEL_UPSTREAM_ERROR",
      threadRun: {
        id: "run-1",
        idempotencyKey: "sourceweft-web-run:run-1",
        status: "running",
        mode: "edit",
      },
    },
  });

  assert.equal(findLatestActiveThreadRunMessage([assistant]), null);
});

test("raw tool schema failures are sanitized for persisted error versions", () => {
  const rawError =
    'Error invoking tool \'publish_artifact\' with kwargs {"brief":"x","slides":[{"kind":"title"}]} with error: Error: Received tool input did not match expected schema\n\n✖ Invalid input: expected string, received undefined\n  → at title';
  const userMessage = createMessage({
    id: "user-1",
    role: "user",
    content: "PPT Deck 生成费曼学习法的讲解PPT",
  });
  const assistant = createMessage({
    id: "assistant-error",
    role: "assistant",
    content: rawError,
    metadata: {
      isError: true,
      error: rawError,
      errorCode: "MODEL_UPSTREAM_ERROR",
      userMessageId: "user-1",
      sourceUserMessageId: "user-1",
    },
  });

  const assistantGroup = buildVersionedMessageGroups([
    userMessage,
    assistant,
  ]).find((group) => group.role === "assistant");
  const error = assistantGroup?.versions[0]?.error;

  assert.equal(
    sanitizeClientErrorMessage(rawError),
    "publish_artifact failed because the generated tool arguments were invalid. Please retry.",
  );
  assert.equal(
    error,
    "publish_artifact failed because the generated tool arguments were invalid. Please retry.",
  );
  assert.doesNotMatch(
    error ?? "",
    /kwargs|schema|brief|slides|expected string/i,
  );
});

test("completed presentation publisher with error is not treated as artifact card ready", () => {
  assert.equal(
    isCompletedArtifactToolCall(
      {
        id: "tool-1",
        tool: "publish_artifact",
        input: {},
        output: {
          artifact_url:
            "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
          status: "ready",
        },
        latencyMs: 10,
        status: "completed",
        error: "publish failed",
      },
      { type: "tool-call-result", id: "tool-1" },
    ),
    false,
  );
});

/** Readiness is the owning capability's call, not this file's. */
function artifactToolCall(
  tool: string,
  output: unknown,
): Parameters<typeof isCompletedArtifactToolCall>[0] {
  return {
    id: "tool-1",
    tool,
    input: {},
    output,
    latencyMs: 10,
    status: "completed",
    error: null,
  };
}

const RESULT_EVENT = { type: "tool-call-result", id: "tool-1" } as const;

test("published deck is artifact-ready on a returned URL, and not without one", () => {
  assert.equal(
    isCompletedArtifactToolCall(
      artifactToolCall("publish_artifact", { status: "needs_content" }),
      RESULT_EVENT,
    ),
    false,
  );

  assert.equal(
    isCompletedArtifactToolCall(
      artifactToolCall("publish_artifact", {
        artifact_url: "/artifact-preview?artifactId=artifact-1",
      }),
      RESULT_EVENT,
    ),
    true,
  );
});

test("a capability with no readiness opinion is ready once the call completes", () => {
  assert.equal(
    isCompletedArtifactToolCall(
      artifactToolCall("generate_image", { artifact_id: "artifact-1" }),
      RESULT_EVENT,
    ),
    true,
  );
});

test("tools that declare no renderAs never trigger an artifact refresh", () => {
  assert.equal(
    isCompletedArtifactToolCall(
      artifactToolCall("web_search", { results: [] }),
      RESULT_EVENT,
    ),
    false,
  );
});

test("terminal failed messages do not restore stale active thread runs", () => {
  const assistant = createMessage({
    id: "assistant-failed",
    role: "assistant",
    metadata: {
      finishReason: "command_success_criteria_failed",
      threadRun: {
        id: "run-1",
        idempotencyKey: "sourceweft-web-run:run-1",
        status: "running",
        mode: "send",
      },
    },
  });

  assert.equal(findLatestActiveThreadRunMessage([assistant]), null);
});

test("notion tool calls hide request params and raw connector payload", () => {
  const toolCall = normalizeToolCallRecord({
    id: "tool-1",
    tool: "create_notion_page",
    input: {
      title: "对话总结：服务器配置查询",
      content: "private conversation summary",
    },
    output: {
      url: "https://www.notion.so/page",
      title: "服务器配置查询总结",
      pageId: "page-1",
      postActionSyncRunId: "sync-1",
      content: "private conversation summary",
    },
    status: "completed",
  });

  assert.deepEqual(toolCall?.input, {});
  assert.deepEqual(toolCall?.output, {
    type: "connector_tool_result",
    connector: "notion",
    toolName: "create_notion_page",
    title: "服务器配置查询总结",
    url: "https://www.notion.so/page",
    pageId: "page-1",
  });
});

test("notion search tool calls keep public result summaries", () => {
  const toolCall = normalizeToolCallRecord({
    id: "tool-1",
    tool: "search_notion_pages",
    input: {
      query: "服务器",
      connectorId: "connector-1",
    },
    output: {
      actionType: "notion.page.find",
      query: "服务器",
      resultCount: 2,
      pages: [
        {
          pageId: "page-1",
          title: "服务器配置",
          url: "https://www.notion.so/page-1",
          lastEditedTime: "2026-05-23T01:00:00.000Z",
          content: "private page body",
        },
      ],
    },
    status: "completed",
  });

  assert.deepEqual(toolCall?.input, {});
  assert.deepEqual(toolCall?.output, {
    type: "connector_tool_result",
    connector: "notion",
    toolName: "search_notion_pages",
    actionType: "notion.page.find",
    query: "服务器",
    resultCount: 2,
    pages: [
      {
        pageId: "page-1",
        title: "服务器配置",
        url: "https://www.notion.so/page-1",
        lastEditedTime: "2026-05-23T01:00:00.000Z",
      },
    ],
  });
});

test("notion confirmation tool calls keep confirmation UI data but hide request params", () => {
  const toolCall = normalizeToolCallRecord({
    id: "tool-1",
    tool: "create_notion_page",
    input: {
      title: "对话总结：服务器配置查询",
      content: "private conversation summary",
    },
    output: {
      type: "tool_confirmation_request",
      schemaVersion: 1,
      id: "action-1",
      domain: "connector",
      subject: {
        label: "Lei Qin",
        provider: "notion",
        connectorId: "connector-1",
      },
      action: {
        type: "notion.page.create",
        toolName: "create_notion_page",
        label: "Create",
        riskLevel: "medium",
        status: "proposed",
        requiresApproval: true,
      },
      preview: {
        title: "Create Notion page: 服务器配置查询总结",
        summary: "Create Notion page: 服务器配置查询总结",
        requestJson: {
          title: "服务器配置查询总结",
          content: "private conversation summary",
        },
        target: {
          type: "notion_private",
          label: "Private page in Notion workspace",
        },
      },
      editableArgs: {
        value: {
          title: "服务器配置查询总结",
          content: "private conversation summary",
        },
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
    },
    status: "completed",
  });

  assert.deepEqual(toolCall?.input, {});
  assert.equal(
    (toolCall?.output as Record<string, unknown> | null)?.type,
    "tool_confirmation_request",
  );
  assert.equal(
    (
      (toolCall?.output as Record<string, unknown> | null)?.preview as Record<
        string,
        unknown
      >
    )?.title,
    "Create Notion page: 服务器配置查询总结",
  );
  assert.equal(
    "requestJson" in
      ((toolCall?.output as Record<string, unknown> | null)?.preview as Record<
        string,
        unknown
      >),
    false,
  );
  assert.equal(
    "editableArgs" in (toolCall?.output as Record<string, unknown>),
    false,
  );
});

test("legacy completed confirmation tool calls normalize to approval requested", () => {
  const toolCall = normalizeToolCallRecord({
    id: "tool-1",
    tool: "delete_notion_page",
    input: {
      pageId: "page_1",
    },
    output: {
      type: "tool_confirmation_request",
      schemaVersion: 1,
      id: "action-1",
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
        title: "Delete Notion page: Referenced",
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
    },
    status: "completed",
  });

  assert.equal(toolCall?.status, "approval_requested");
});

test("streamed confirmation tool results resolve to approval requested", () => {
  const toolCall = resolveToolCallFromStreamEvent({
    event: {
      type: "tool-call-result",
      id: "tool-1",
      tool: "delete_notion_page",
      input: {
        pageId: "page_1",
      },
      output: {
        type: "tool_confirmation_request",
        schemaVersion: 1,
        id: "action-1",
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
          title: "Delete Notion page: Referenced",
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
      },
      latencyMs: 0,
    },
    streamToolCallsById: new Map(),
  });

  assert.equal(toolCall.status, "approval_requested");
});

test("active confirmations do not require finish reason and survive assistant id changes", () => {
  const userMessage = createMessage({
    id: "user-1",
    role: "user",
    content: "Delete Referenced",
  });
  const temporaryAssistant = createMessage({
    id: "temp-assistant",
    role: "assistant",
    metadata: {
      userMessageId: "user-1",
      threadRun: {
        id: "run-1",
        idempotencyKey: "sw-run-test",
        status: "waiting_for_approval",
        mode: "send",
      },
      toolCalls: [
        {
          id: "tool-1",
          tool: "delete_notion_page",
          input: {},
          output: {
            type: "tool_confirmation_request",
            schemaVersion: 1,
            id: "action-1",
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
              title: "Delete Notion page: Referenced",
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
          },
          status: "completed",
        },
      ],
    },
  });
  const persistedAssistant = createMessage({
    ...temporaryAssistant,
    id: "assistant-1",
    metadata: {
      ...temporaryAssistant.metadata,
      sourceAssistantMessageId: "temp-assistant",
    },
  });

  const beforeAssistantGroup = buildVersionedMessageGroups([
    userMessage,
    temporaryAssistant,
  ]).find((group) => group.role === "assistant");
  const afterAssistantGroup = buildVersionedMessageGroups([
    userMessage,
    persistedAssistant,
  ]).find((group) => group.role === "assistant");
  const beforeVersion = beforeAssistantGroup?.versions.find(
    (version) => version.id === "temp-assistant",
  );
  const afterVersion = afterAssistantGroup?.versions.find(
    (version) => version.id === "assistant-1",
  );

  assert.equal(beforeVersion?.toolCalls?.[0]?.id, "tool-1");
  assert.equal(afterVersion?.toolCalls?.[0]?.id, "tool-1");
  assert.equal(afterVersion?.id, "assistant-1");
  assert.equal(afterVersion?.threadRun?.id, "run-1");
});

test("assistant versions are indexable by persisted message id after edits", () => {
  const userMessage = createMessage({
    id: "user-1",
    role: "user",
    content: "Delete Referenced",
  });
  const assistantOriginal = createMessage({
    id: "assistant-1",
    role: "assistant",
    metadata: {
      userMessageId: "user-1",
      sourceUserMessageId: "user-1",
    },
  });
  const editedUserMessage = createMessage({
    id: "user-2",
    role: "user",
    content: "Delete Referenced after edit",
    parentMessageId: "user-1",
    metadata: {
      versionOf: "user-1",
    },
  });
  const editedAssistant = createMessage({
    id: "assistant-2",
    role: "assistant",
    parentMessageId: "assistant-1",
    metadata: {
      userMessageId: "user-2",
      sourceUserMessageId: "user-2",
      threadRun: {
        id: "run-edit",
        status: "waiting_for_approval",
      },
    },
  });

  const assistantVersionById = new Map(
    buildVersionedMessageGroups([
      userMessage,
      assistantOriginal,
      editedUserMessage,
      editedAssistant,
    ])
      .filter((group) => group.role === "assistant")
      .flatMap((group) =>
        group.versions.map(
          (version, branchIndex) =>
            [
              version.id,
              {
                branchIndex,
                groupId: group.groupId,
                version,
              },
            ] as const,
        ),
      ),
  );

  const entry = assistantVersionById.get("assistant-2");
  assert.equal(entry?.version.id, "assistant-2");
  assert.equal(entry?.version.threadRun?.id, "run-edit");
  assert.equal(entry?.branchIndex, 1);
});

test("old assistant messages without renderBlocks metadata do not synthesize render blocks", () => {
  const assistant = createMessage({
    id: "assistant-old",
    role: "assistant",
    content: "Old answer body remains visible.",
    metadata: {
      toolCalls: [
        {
          id: "tool-1",
          tool: "search_web",
          input: { query: "sourceweft" },
          output: { resultCount: 1 },
          status: "completed",
        },
      ],
      traceParts: [
        {
          createdAt: new Date(0).toISOString(),
          id: "trace-tool-1",
          input: { query: "sourceweft" },
          kind: "tool",
          order: 1,
          status: "completed",
          tool: "search_web",
          toolCallId: "tool-1",
          updatedAt: new Date(0).toISOString(),
        },
        {
          createdAt: new Date(1).toISOString(),
          id: "trace-step-1",
          items: ["checked selected sources"],
          kind: "step",
          order: 2,
          status: "completed",
          title: "Checked sources",
          updatedAt: new Date(1).toISOString(),
        },
      ],
    },
  });

  const version = buildVersionedMessageGroups([assistant])[0]?.versions[0];

  assert.equal(version?.content, "Old answer body remains visible.");
  assert.deepEqual(version?.renderBlocks, []);
  assert.equal(version?.toolCalls?.[0]?.id, "tool-1");
  const tracePart = version?.traceParts?.[0];
  assert.equal(tracePart?.kind, "tool");
  assert.equal(
    tracePart?.kind === "tool" ? tracePart.toolCallId : undefined,
    "tool-1",
  );
});

test("renderBlocks metadata presence is explicit", () => {
  assert.equal(hasRenderBlocksMetadata({}), false);
  assert.equal(hasRenderBlocksMetadata({ renderBlocks: "bad" }), false);
  assert.equal(hasRenderBlocksMetadata({ renderBlocks: [] }), true);
  assert.deepEqual(resolveRenderBlocksFromMetadata({ renderBlocks: [] }), []);
  assert.deepEqual(
    resolveRenderBlocksFromMetadata({
      renderBlocks: [
        {
          artifactId: "artifact-1",
          artifactVersionId: "version-1",
          id: "artifact-1",
          placement: "terminal",
          producer: { kind: "main" },
          sequence: 1,
          sourceToolCallId: "tool-1",
          threadRunId: "run-1",
          type: "artifact_output",
        },
        { id: "text-1", text: "Partial answer", type: "text" },
      ],
    }),
    [
      {
        artifactId: "artifact-1",
        artifactVersionId: "version-1",
        id: "artifact-1",
        placement: "terminal",
        producer: { kind: "main" },
        sequence: 1,
        sourceToolCallId: "tool-1",
        threadRunId: "run-1",
        type: "artifact_output",
      },
      { id: "text-1", text: "Partial answer", type: "text" },
    ],
  );
});

test("resolveRenderBlocksFromMetadata ignores legacy trace parts and content", () => {
  assert.deepEqual(
    resolveRenderBlocksFromMetadata(
      {
        traceParts: [
          {
            createdAt: new Date(0).toISOString(),
            durationMs: 2400,
            id: "reasoning-1",
            kind: "reasoning",
            order: 0,
            text: "I should search first.",
            updatedAt: new Date(0).toISOString(),
          },
          {
            createdAt: new Date(1).toISOString(),
            id: "tool-1",
            input: {},
            kind: "tool",
            order: 1,
            status: "completed",
            tool: "web_search",
            toolCallId: "call-1",
            updatedAt: new Date(1).toISOString(),
          },
        ],
      },
      { content: "Final answer." },
    ),
    [],
  );
});

test("resolveRenderBlocksFromMetadata ignores legacy tool calls without render blocks", () => {
  assert.deepEqual(
    resolveRenderBlocksFromMetadata(
      {
        toolCalls: [
          {
            id: "call-1",
            input: {},
            output: null,
            status: "completed",
            tool: "web_search",
          },
        ],
      },
      { content: "Final answer." },
    ),
    [],
  );
});

test("empty renderBlocks metadata stays empty for interrupted assistant content", () => {
  const assistant = createMessage({
    id: "assistant-interrupted",
    role: "assistant",
    content: "Partial answer before interruption.",
    metadata: {
      renderBlocks: [],
      [STREAM_TEXT_INTERRUPTED_KEY]: true,
    },
  });

  const version = buildVersionedMessageGroups([assistant])[0]?.versions[0];

  assert.equal(version?.content, "Partial answer before interruption.");
  assert.deepEqual(version?.renderBlocks, []);
  assert.equal(version?.isTextInterrupted, true);
});

test("completed local and persisted replies for one run do not become separate versions or swap turns", () => {
  const user1 = createMessage({
    id: "user-1",
    role: "user",
    createdAt: new Date(100).toISOString(),
  });
  const answer1 = createMessage({
    id: "answer-1",
    role: "assistant",
    content: "first reply",
    createdAt: new Date(101).toISOString(),
    metadata: { userMessageId: "user-1" },
  });
  const user2 = createMessage({
    id: "user-2",
    role: "user",
    createdAt: new Date(300).toISOString(),
  });
  const run = {
    id: "run-2",
    idempotencyKey: "sourceweft-web-run:2",
    assistantMessageId: "answer-2",
    status: "completed",
  };
  const temp = createMessage({
    id: "temp-assistant-2",
    role: "assistant",
    content: "second reply",
    createdAt: new Date(250).toISOString(),
    metadata: { userMessageId: "user-2", threadRun: run },
  });
  const persisted = createMessage({
    ...temp,
    id: "answer-2",
    createdAt: new Date(301).toISOString(),
  });
  const groups = buildVersionedMessageGroups([
    user1,
    answer1,
    temp,
    user2,
    persisted,
  ]);
  assert.deepEqual(
    groups.map((group) => [
      group.role,
      group.versions.map((version) => version.id),
    ]),
    [
      ["user", ["user-1"]],
      ["assistant", ["answer-1"]],
      ["user", ["user-2"]],
      ["assistant", ["answer-2"]],
    ],
  );
});

test("explicit prompt association is respected before its later server timestamp even without persisted reply", () => {
  const user1 = createMessage({
    id: "user-1",
    role: "user",
    createdAt: new Date(100).toISOString(),
  });
  const answer1 = createMessage({
    id: "answer-1",
    role: "assistant",
    createdAt: new Date(101).toISOString(),
    metadata: { userMessageId: "user-1" },
  });
  const user2 = createMessage({
    id: "user-2",
    role: "user",
    createdAt: new Date(300).toISOString(),
  });
  const temp = createMessage({
    id: "temp-assistant-2",
    role: "assistant",
    createdAt: new Date(50).toISOString(),
    metadata: { userMessageId: "user-2" },
  });
  const groups = buildVersionedMessageGroups([temp, user1, answer1, user2]);
  assert.deepEqual(
    groups.map((group) => group.turnId),
    ["turn:user-1", "turn:user-1", "turn:user-2", "turn:user-2"],
  );
});

test("normalization preserves persisted MCP display names without altering execution names", () => {
  const tool = "mcp__anycrawl_abcd1234__sea_7890abcd";
  const record = normalizeToolCallRecord({
    id: "mcp",
    tool,
    input: {},
    status: "completed",
    mcpDisplay: { serverName: "AnyCrawl", toolName: "Search full articles" },
  });
  assert.equal(record?.tool, tool);
  assert.deepEqual(record?.mcpDisplay, {
    serverName: "AnyCrawl",
    toolName: "Search full articles",
  });
});

test("production MCP approval and legacy completed records recover reliable labels on refresh", () => {
  const tool =
    "mcp__com_microsoft_microsoft-learn-mc_371294fd__microso_9eda69db";
  const mcpDisplay = {
    serverName: "Microsoft Learn MCP",
    toolName: "microsoft_docs_search",
  };
  const approval = normalizeToolCallRecord({
    id: "approval",
    tool,
    input: {},
    status: "completed",
    output: {
      type: "tool_confirmation_request",
      subject: { provider: "mcp", label: mcpDisplay.serverName },
      action: { toolName: tool, label: mcpDisplay.toolName },
    },
  });
  assert.deepEqual(approval?.mcpDisplay, mcpDisplay);
  const metadata = JSON.parse(
    JSON.stringify({
      toolCalls: [
        {
          id: "search",
          tool,
          input: {},
          status: "completed",
          output: {
            name: "mcp__com_microsoft_microsoft-learn-mc_371294fd__microsoft_docs_search",
          },
        },
      ],
      traceEvents: [
        { payload: { toolCall: { id: "search", tool, mcpDisplay } } },
      ],
    }),
  );
  const restored = resolveToolCallsFromMetadata(metadata);
  assert.deepEqual(restored[0]?.mcpDisplay, mcpDisplay);
  assert.equal(restored[0]?.tool, tool);
  metadata.traceEvents[0].payload.toolCall.tool = "different-execution-alias";
  assert.equal(
    resolveToolCallsFromMetadata(metadata)[0]?.mcpDisplay,
    undefined,
  );
});

test("canonical runtime MCP identity takes priority over legacy approval output labels", () => {
  const tool = "mcp__server_hash__tool_hash";
  const canonical = {
    serverName: "Canonical server",
    toolName: "canonical_search",
  };
  const approval = {
    type: "tool_confirmation_request",
    subject: { provider: "mcp", label: "Old server" },
    action: { toolName: tool, label: "Old search" },
  };
  const record = {
    id: "same-call",
    tool,
    status: "completed",
    input: {},
    output: approval,
  };
  const metadata = {
    toolCalls: [record],
    traceEvents: [{ toolCall: { id: record.id, tool, mcpDisplay: canonical } }],
  };
  assert.deepEqual(
    resolveToolCallsFromMetadata(metadata)[0]?.mcpDisplay,
    canonical,
  );
  const explicit = {
    serverName: "Explicit server",
    toolName: "explicit_search",
  };
  assert.deepEqual(
    resolveToolCallsFromMetadata({
      ...metadata,
      toolCalls: [{ ...record, mcpDisplay: explicit }],
    })[0]?.mcpDisplay,
    explicit,
  );
  assert.deepEqual(
    resolveToolCallsFromMetadata({ toolCalls: [record] })[0]?.mcpDisplay,
    { serverName: "Old server", toolName: "Old search" },
  );
});

test("live MCP start preserves canonical display identity without altering execution aliases", () => {
  const tool =
    "mcp__com_microsoft_microsoft-learn-mc_371294fd__microso_9eda69db";
  const mcpDisplay = {
    serverName: "Microsoft Learn MCP",
    toolName: "microsoft_docs_search",
  };
  const call = resolveToolCallFromStreamEvent({
    event: {
      type: "tool-call-start",
      toolCall: {
        id: "call-search",
        tool,
        input: {},
        status: "running",
        mcpDisplay,
      },
    },
    streamToolCallsById: new Map(),
  });
  assert.deepEqual(call.mcpDisplay, mcpDisplay);
  assert.equal(call.tool, tool);
});

test("live MCP result supplies late identity and thin end retains it for the same call", () => {
  const tool =
    "mcp__com_microsoft_microsoft-learn-mc_371294fd__microso_69f82065";
  const mcpDisplay = {
    serverName: "Microsoft Learn MCP",
    toolName: "microsoft_docs_fetch",
  };
  const calls = new Map<string, ToolCallRecord>();
  const start = resolveToolCallFromStreamEvent({
    event: { type: "tool-call-start", id: "call-fetch", tool, input: {} },
    streamToolCallsById: calls,
  });
  assert.equal(start.mcpDisplay, undefined);
  calls.set(start.id, start);
  const result = resolveToolCallFromStreamEvent({
    event: {
      type: "tool-call-result",
      toolCall: {
        id: start.id,
        tool,
        input: {},
        status: "completed",
        mcpDisplay,
      },
      output: { text: "Introduction to Azure Blob Storage" },
    },
    streamToolCallsById: calls,
  });
  assert.deepEqual(result.mcpDisplay, mcpDisplay);
  calls.set(result.id, result);
  const end = resolveToolCallFromStreamEvent({
    event: { type: "tool-call-end", id: start.id, tool, status: "completed" },
    streamToolCallsById: calls,
  });
  assert.deepEqual(end.mcpDisplay, mcpDisplay);
  assert.equal(end.status, "completed");
  assert.equal(end.tool, tool);
});

test("live MCP identity is never inherited across a different tool or call id", () => {
  const tool = "mcp__server__search_hash";
  const previous: ToolCallRecord = {
    id: "old-call",
    tool,
    input: {},
    output: null,
    status: "running",
    error: null,
    latencyMs: null,
    mcpDisplay: { serverName: "Server", toolName: "search" },
  };
  const calls = new Map([[previous.id, previous]]);
  const otherTool = resolveToolCallFromStreamEvent({
    event: {
      type: "tool-call-end",
      id: previous.id,
      tool: "mcp__server__fetch_hash",
      status: "completed",
    },
    streamToolCallsById: calls,
  });
  assert.equal(otherTool.mcpDisplay, undefined);
  const otherId = resolveToolCallFromStreamEvent({
    event: {
      type: "tool-call-start",
      id: previous.id,
      toolCall: { id: "new-call", tool, input: {}, status: "running" },
    },
    streamToolCallsById: calls,
  });
  assert.equal(otherId.id, "new-call");
  assert.equal(otherId.mcpDisplay, undefined);
});

test("public run budget survives real message grouping without leaking private metadata", () => {
  const progress = {
    policyVersion: 2,
    phase: "closing",
    normalSteps: 2,
    normalLimit: 2,
    closingSteps: 1,
    closingLimit: 40,
    steps: 3,
    limit: 42,
  };
  const message = createMessage({
    id: "budget-assistant",
    role: "assistant",
    metadata: {
      agentRunProgress: progress,
      privateCheckpoint: { secret: "do-not-project" },
      threadRun: { status: "running" },
      sourceUserMessageId: "user-budget",
    },
  });
  const version = buildVersionedMessageGroups([message])[0]!.versions[0]!;
  assert.deepEqual(
    readMessageAgentRunProgress({
      role: "assistant",
      version,
      isLatestAssistantGroup: true,
      isActiveVersion: true,
      isRunActive: true,
    }),
    progress,
  );
  assert.equal(version.metadata?.privateCheckpoint, undefined);
  assert.equal(version.threadRun?.status, "running");
  assert.equal(version.sourceUserMessageId, "user-budget");
  assert.equal(
    readMessageAgentRunProgress({
      role: "assistant",
      version,
      isLatestAssistantGroup: true,
      isActiveVersion: false,
      isRunActive: true,
    }),
    null,
  );
  const stop = {
    policyVersion: 2,
    reason: "step_limit",
    normalSteps: 2,
    normalLimit: 2,
    closingSteps: 40,
    closingLimit: 40,
    steps: 42,
    limit: 42,
    canContinue: true,
    summaryStatus: "completed",
  };
  const stopped = buildVersionedMessageGroups([
    {
      ...message,
      metadata: {
        ...message.metadata,
        agentRunProgress: {
          ...progress,
          phase: "finalizing",
          closingSteps: 40,
          steps: 42,
        },
        agentRunStop: stop,
        threadRun: { status: "completed" },
      },
    },
  ])[0]!.versions[0]!;
  assert.deepEqual(
    readMessageAgentRunStop({
      role: "assistant",
      version: stopped,
      isLatestAssistantGroup: true,
      isActiveVersion: true,
    }),
    stop,
  );
  assert.equal(
    readMessageAgentRunProgress({
      role: "assistant",
      version: stopped,
      isLatestAssistantGroup: true,
      isActiveVersion: true,
      isRunActive: false,
    }),
    null,
  );
});
test("message grouping rejects malformed run budgets and preserves historical stop notices", () => {
  const legacyStop = {
    reason: "step_limit",
    steps: 400,
    limit: 400,
    canContinue: true,
    summaryStatus: "failed",
  };
  const version = buildVersionedMessageGroups([
    createMessage({
      id: "legacy-budget",
      role: "assistant",
      metadata: {
        agentRunStop: legacyStop,
        agentRunProgress: {
          policyVersion: 2,
          phase: "closing",
          namespace: "private",
        },
      },
    }),
  ])[0]!.versions[0]!;
  assert.deepEqual(
    readMessageAgentRunStop({
      role: "assistant",
      version,
      isLatestAssistantGroup: true,
      isActiveVersion: true,
    }),
    legacyStop,
  );
  assert.equal(version.metadata?.agentRunProgress, undefined);
  const invalid = buildVersionedMessageGroups([
    createMessage({
      id: "invalid-budget",
      role: "assistant",
      metadata: {
        agentRunStop: { ...legacyStop, privateCheckpoint: "secret" },
      },
    }),
  ])[0]!.versions[0]!;
  assert.equal(
    readMessageAgentRunStop({
      role: "assistant",
      version: invalid,
      isLatestAssistantGroup: true,
      isActiveVersion: true,
    }),
    null,
  );
});

test("failed real message projection hides closing progress when active-run state lags", () => {
  const progress = {
    policyVersion: 2,
    phase: "closing",
    normalSteps: 2,
    normalLimit: 2,
    closingSteps: 9,
    closingLimit: 40,
    steps: 11,
    limit: 42,
  };
  const version = buildVersionedMessageGroups([
    createMessage({
      id: "failed-closing",
      role: "assistant",
      metadata: {
        isError: true,
        agentRunProgress: progress,
        threadRun: { status: "failed" },
      },
    }),
  ])[0]!.versions[0]!;
  assert.equal(version.isError, true);
  assert.equal(version.metadata?.isError, undefined);
  assert.equal(
    readMessageAgentRunProgress({
      role: "assistant",
      version,
      isLatestAssistantGroup: true,
      isActiveVersion: true,
      isRunActive: true,
    }),
    null,
  );
});

test("live same-call retries preserve omitted errors but clear explicit null and new starts", () => {
  const calls = new Map<string, ToolCallRecord>();
  const failed = resolveToolCallFromStreamEvent({
    event: {
      type: "tool-call-error",
      id: "retry-read",
      tool: "read_file",
      error: "sandbox unhealthy",
    },
    streamToolCallsById: calls,
  });
  calls.set(failed.id, failed);
  const omitted = resolveToolCallFromStreamEvent({
    event: { type: "tool-call-end", id: failed.id, status: "completed" },
    streamToolCallsById: calls,
  });
  assert.equal(omitted.error, "sandbox unhealthy");
  const cleared = resolveToolCallFromStreamEvent({
    event: {
      type: "tool-call-result",
      id: failed.id,
      toolCall: {
        id: failed.id,
        tool: "read_file",
        status: "completed",
        error: null,
      },
    },
    streamToolCallsById: calls,
  });
  assert.equal(cleared.error, null);
  // SSE JSON may carry an explicit top-level null even though error events
  // normally advertise a string. Preserve the wire presence distinction.
  const topClear = resolveToolCallFromStreamEvent({
    event: JSON.parse(
      JSON.stringify({ type: "tool-call-result", id: failed.id, error: null }),
    ),
    streamToolCallsById: calls,
  });
  assert.equal(topClear.error, null);
  const restarted = resolveToolCallFromStreamEvent({
    event: { type: "tool-call-start", id: failed.id, tool: "read_file" },
    streamToolCallsById: calls,
  });
  assert.equal(restarted.error, null);
  assert.equal(restarted.status, "running");
  calls.set(restarted.id, restarted);
  const failedAgain = resolveToolCallFromStreamEvent({
    event: {
      type: "tool-call-error",
      id: failed.id,
      error: "new permission failure",
    },
    streamToolCallsById: calls,
  });
  assert.equal(failedAgain.error, "new permission failure");
});

test("reload rendering resolves tool output from toolCalls when persisted trace parts and events are output-free", () => {
  // #330: persisted `traceParts` carry no `output` and persisted `traceEvents`
  // carry neither `payload` nor `toolCall.output`; `metadata.toolCalls` is the
  // single full copy. The reload path must render exactly that copy.
  const createdAt = new Date(0).toISOString();
  const mcpDisplay = { serverName: "Docs", toolName: "Search docs" };
  const stdout = "line\n".repeat(400);
  const executeOutput = JSON.stringify({
    ok: true,
    output: stdout,
    truncated: true,
    exitCode: 0,
  });
  const searchOutput = { content: "y".repeat(500) };
  const assistant = createMessage({
    id: "assistant-reload",
    role: "assistant",
    content: "Done.",
    metadata: {
      toolCalls: [
        {
          id: "exec-1",
          tool: "execute",
          input: { command: "ls -R" },
          output: executeOutput,
          status: "completed",
          latencyMs: 12,
          error: null,
          sequence: 1,
        },
        {
          id: "search-1",
          tool: "search_docs",
          input: { query: "bounds" },
          output: searchOutput,
          status: "completed",
          latencyMs: 5,
          error: null,
          sequence: 2,
        },
      ],
      traceParts: [
        {
          id: "part-exec-1",
          kind: "tool",
          order: 1,
          createdAt,
          updatedAt: createdAt,
          toolCallId: "exec-1",
          tool: "execute",
          status: "completed",
          input: { command: "ls -R" },
          error: null,
          latencyMs: 12,
        },
        {
          id: "part-search-1",
          kind: "tool",
          order: 2,
          createdAt,
          updatedAt: createdAt,
          toolCallId: "search-1",
          tool: "search_docs",
          status: "completed",
          input: { query: "bounds" },
          error: null,
          latencyMs: 5,
          mcpDisplay,
        },
      ],
      traceEvents: [
        {
          type: "tool-call",
          id: "exec-1:1",
          itemId: "exec-1",
          sequence: 1,
          eventType: "tool-call-end",
          tool: "execute",
          toolCall: {
            id: "exec-1",
            tool: "execute",
            status: "completed",
            latencyMs: 12,
            error: null,
            sequence: 1,
          },
        },
        {
          type: "tool-call",
          id: "search-1:2",
          itemId: "search-1",
          sequence: 2,
          eventType: "tool-call-end",
          tool: "search_docs",
          toolCall: {
            id: "search-1",
            tool: "search_docs",
            mcpDisplay,
            status: "completed",
            latencyMs: 5,
            error: null,
            sequence: 2,
          },
        },
      ],
    },
  });

  const version = buildVersionedMessageGroups([assistant])[0]?.versions[0];
  assert.ok(version);
  const serializedTraceEvents = JSON.stringify(version.traceEvents);
  assert.equal(serializedTraceEvents.includes("yyyyyyyy"), false);
  assert.equal(serializedTraceEvents.includes("payload"), false);
  assert.equal(version.traceEvents?.length, 2);
  assert.deepEqual(
    version.toolCalls?.find((toolCall) => toolCall.id === "search-1")
      ?.mcpDisplay,
    mcpDisplay,
  );

  const state = buildMessageRenderState({
    isAssistantStreaming: false,
    role: "assistant",
    version,
  });
  const toolItems = state.activityItems.filter(
    (
      item,
    ): item is Extract<
      (typeof state.activityItems)[number],
      { type: "tool" }
    > => item.type === "tool",
  );
  assert.deepEqual(
    toolItems.map((item) => item.toolCall.id),
    ["exec-1", "search-1"],
  );
  for (const item of toolItems) {
    const canonical: ToolCallRecord | undefined = version.toolCalls?.find(
      (toolCall) => toolCall.id === item.toolCall.id,
    );
    assert.ok(canonical);
    assert.notEqual(canonical.output, null);
    assert.deepEqual(item.toolCall.output, canonical.output);
  }
  assert.deepEqual(toolItems[1]?.toolCall.mcpDisplay, mcpDisplay);
  const sandboxView = getSandboxExecuteView({
    input: toolItems[0]!.toolCall.input,
    output: toolItems[0]!.toolCall.output,
    toolName: "execute",
  });
  assert.equal(sandboxView?.output, stdout);
  assert.equal(sandboxView?.truncated, true);
  assert.deepEqual(toolItems[1]?.toolCall.output, searchOutput);
});

/**
 * #333 reload equivalence. The `/messages` client view of an assistant row no
 * longer carries `meteredLlmCalls`, `reasoning`, `traceEvents`, segment text,
 * reasoning trace part text, trace part `input` or citation `quoteText`; the
 * backend backfills `toolCalls[].mcpDisplay` from `traceEvents` before it
 * omits them. Everything the UI renders after reload must be identical.
 */
function buildReloadEquivalenceRows() {
  const createdAt = new Date(0).toISOString();
  const updatedAt = new Date(1000).toISOString();
  const mcpDisplay = { serverName: "Docs", toolName: "Search docs" };
  const executeOutput = JSON.stringify({
    ok: true,
    output: "src\nsrc/index.ts\n",
    truncated: false,
    exitCode: 0,
  });
  const citation = (index: number) => ({
    citation: `[${index}]`,
    sourceId: "source-1",
    sourceTitle: "Handbook",
    documentId: "document-1",
    chunkId: `chunk-${index}`,
    chunkNo: index,
    score: 0.9 - index / 100,
    excerpt: `Excerpt ${index} of the handbook.`,
    quoteText: `Excerpt ${index} of the handbook.`,
    origin: "knowledge",
    path: "/handbook.md",
  });
  const availableCitations = [citation(1), citation(2)];
  const toolCalls = [
    {
      id: "read-1",
      tool: "read_file",
      input: { file_path: "/workspace/notes.md", offset: 0, limit: 40 },
      output: "     1\t# Notes\n     2\tHello\n",
      latencyMs: 4,
      status: "completed",
      error: null,
      sequence: 1,
    },
    {
      id: "exec-1",
      tool: "execute",
      input: { command: "ls -R src" },
      output: executeOutput,
      latencyMs: 12,
      status: "completed",
      error: null,
      sequence: 2,
    },
    {
      id: "write-1",
      tool: "write_file",
      input: {
        file_path: "/workspace/out.ts",
        content: "export const a = 1;\n",
      },
      output: "Updated file /workspace/out.ts",
      latencyMs: 3,
      status: "completed",
      error: null,
      sequence: 3,
    },
    {
      id: "task-1",
      tool: "task",
      input: { subagent_type: "researcher", description: "Find the policy" },
      output: "The policy is in section 4.",
      latencyMs: 900,
      status: "completed",
      error: null,
      sequence: 4,
      producer: { kind: "main" },
    },
    {
      id: "search-1",
      tool: "search_docs",
      input: { query: "retention policy" },
      output: { content: "Retention is 30 days." },
      latencyMs: 5,
      status: "completed",
      error: null,
      sequence: 5,
    },
    {
      id: "notion-1",
      tool: "create_notion_page",
      input: { title: "Summary" },
      output: {
        type: "tool_confirmation_request",
        id: "confirmation-1",
        status: "pending",
      },
      latencyMs: null,
      status: "approval_requested",
      error: null,
      sequence: 6,
      approvalConfirmationId: "confirmation-1",
    },
  ];
  const reasoningText = (index: number) =>
    `Thinking step ${index}: decide the next tool.`;
  const oldSegments = [1, 2].map((index) => ({
    id: `model-reasoning:run-1:${index}`,
    text: reasoningText(index),
    sequence: index,
    durationMs: 1000 * index,
    phase: index === 1 ? "initial" : "after_tool",
    ...(index === 2 ? { toolCallId: "read-1", tool: "read_file" } : {}),
  }));
  const toolPart = (
    call: (typeof toolCalls)[number],
    order: number,
    withInput: boolean,
  ) => ({
    id: `part-${call.id}`,
    kind: "tool",
    order,
    createdAt,
    updatedAt,
    toolCallId: call.id,
    tool: call.tool,
    status: call.status,
    ...(withInput ? { input: call.input } : {}),
    error: call.error,
    latencyMs: call.latencyMs,
    ...(call.approvalConfirmationId
      ? { approvalConfirmationId: call.approvalConfirmationId }
      : {}),
  });
  const traceParts = (legacy: boolean) => [
    {
      id: "model-reasoning:run-1:1",
      kind: "reasoning",
      order: 0,
      createdAt,
      updatedAt,
      ...(legacy ? { text: reasoningText(1) } : {}),
      phase: "initial",
      durationMs: 1000,
    },
    ...toolCalls.slice(0, 1).map((call) => toolPart(call, 1, legacy)),
    {
      id: "model-reasoning:run-1:2",
      kind: "reasoning",
      order: 2,
      createdAt,
      updatedAt,
      ...(legacy ? { text: reasoningText(2) } : {}),
      phase: "after_tool",
      toolCallId: "read-1",
      tool: "read_file",
      durationMs: 2000,
    },
    ...toolCalls
      .slice(1)
      .map((call, index) => toolPart(call, index + 3, legacy)),
    {
      id: "step-1",
      kind: "step",
      order: 9,
      createdAt,
      updatedAt,
      title: "Checked selected sources",
      status: "completed",
      items: ["Handbook"],
    },
  ];
  const renderBlocks = [
    {
      id: "reasoning-model-reasoning:run-1:1",
      type: "reasoning",
      text: reasoningText(1),
      durationMs: 1000,
    },
    { id: "tool-read-1", type: "tool", toolCallId: "read-1" },
    {
      id: "reasoning-model-reasoning:run-1:2",
      type: "reasoning",
      text: reasoningText(2),
      durationMs: 2000,
    },
    ...toolCalls.slice(1).map((call) => ({
      id: `tool-${call.id}`,
      type: "tool",
      toolCallId: call.id,
    })),
    { id: "text-1", type: "text", text: "Retention is 30 days [1]." },
  ];
  const baseMetadata = {
    finishReason: "tool_confirmation_requested",
    threadRun: { id: "run-1", status: "waiting_for_approval", mode: "send" },
    renderBlocks,
    thinkingSteps: [
      {
        id: "step-1",
        title: "Checked selected sources",
        status: "completed",
        items: ["Handbook"],
        sequence: 1,
      },
    ],
  };
  const oldRow = createMessage({
    id: "assistant-333",
    role: "assistant",
    content: "Retention is 30 days [1].",
    metadata: {
      ...baseMetadata,
      // Legacy: `search-1` lost its display on the finalized tool call; only
      // the trace event still carries it.
      toolCalls,
      traceParts: traceParts(true),
      reasoning: `${reasoningText(1)}${reasoningText(2)}`,
      reasoningSegments: oldSegments,
      traceEvents: [
        ...oldSegments.map((segment) => ({
          type: "reasoning",
          id: `${segment.id}:${segment.sequence}`,
          itemId: segment.id,
          sequence: segment.sequence,
          reasoning: segment.text,
          segment,
        })),
        {
          type: "tool-call",
          id: "search-1:5",
          itemId: "search-1",
          sequence: 5,
          eventType: "tool-call-end",
          tool: "search_docs",
          toolCall: {
            id: "search-1",
            tool: "search_docs",
            mcpDisplay,
            status: "completed",
            latencyMs: 5,
            error: null,
            sequence: 5,
          },
        },
      ],
      meteredLlmCalls: [
        { spanId: "span-1", consumedCredits: 3, billingStatus: "settled" },
      ],
      meteredLlmCreditsConsumed: 3,
      retrieval: {
        citations: [availableCitations[0]],
        availableCitations,
      },
    },
  });
  const omitKey = <T extends Record<string, unknown>>(record: T, key: string) =>
    Object.fromEntries(
      Object.entries(record).filter(([entryKey]) => entryKey !== key),
    );
  const stripQuote = (item: ReturnType<typeof citation>) =>
    omitKey(item, "quoteText");
  const newRow = createMessage({
    id: "assistant-333",
    role: "assistant",
    content: "Retention is 30 days [1].",
    metadata: {
      ...baseMetadata,
      toolCalls: toolCalls.map((call) =>
        call.id === "search-1" ? { ...call, mcpDisplay } : call,
      ),
      traceParts: traceParts(false),
      reasoningSegments: oldSegments.map((segment) => omitKey(segment, "text")),
      meteredLlmCreditsConsumed: 3,
      retrieval: {
        citations: [stripQuote(availableCitations[0]!)],
        availableCitations: availableCitations.map(stripQuote),
      },
    },
  });
  return { mcpDisplay, newRow, oldRow };
}

function reloadRenderModel(row: ChatMessageItem) {
  const version = buildVersionedMessageGroups([row])[0]?.versions[0];
  assert.ok(version);
  const state = buildMessageRenderState({
    isAssistantStreaming: false,
    role: "assistant",
    version,
  });
  return {
    version,
    model: {
      status: state.status,
      text: state.text,
      error: state.error,
      // "Thought for Ns" rows and their expanded text come from these blocks.
      bodyBlocks: state.bodyBlocks,
      // Tool cards join render blocks to `toolCalls` by id.
      toolCalls: version.toolCalls,
      toolCards: state.bodyBlocks.flatMap((block) =>
        block.type === "tool"
          ? [version.toolCalls?.find((call) => call.id === block.toolCallId)]
          : [],
      ),
      thinkingSteps: version.thinkingSteps,
      toolActivity: state.activityItems.flatMap((item) =>
        item.type === "tool"
          ? [
              {
                key: item.key,
                toolCall: item.toolCall,
                toolStep: item.toolStep,
              },
            ]
          : [],
      ),
      activityOrder: state.activityItems.map((item) => item.key),
      citations: state.citations,
      availableCitations: state.availableCitations,
      threadRun: version.threadRun,
      finishReason: version.finishReason,
    },
  };
}

test("#333 reload renders the same model from the deduped /messages client view", () => {
  const { mcpDisplay, newRow, oldRow } = buildReloadEquivalenceRows();
  const before = reloadRenderModel(oldRow);
  const after = reloadRenderModel(newRow);

  assert.deepEqual(after.model, before.model);

  // Spot-check that the compared model is the real, populated one.
  const reasoningBlocks = after.model.bodyBlocks.filter(
    (block) => block.type === "reasoning",
  );
  assert.deepEqual(
    reasoningBlocks.map((block) =>
      block.type === "reasoning" ? [block.text, block.durationMs] : null,
    ),
    [
      ["Thinking step 1: decide the next tool.", 1000],
      ["Thinking step 2: decide the next tool.", 2000],
    ],
  );
  assert.equal(after.model.toolCards.length, 6);
  assert.ok(after.model.toolCards.every((call) => call !== undefined));
  assert.deepEqual(
    after.model.toolCalls?.find((call) => call.id === "search-1")?.mcpDisplay,
    mcpDisplay,
  );
  for (const item of after.model.toolActivity) {
    const canonical = after.version.toolCalls?.find(
      (call) => call.id === item.toolCall.id,
    );
    assert.ok(canonical);
    assert.deepEqual(item.toolCall.input, canonical.input);
    assert.deepEqual(item.toolCall.output, canonical.output);
  }
  assert.equal(
    after.model.toolActivity.find((item) => item.toolCall.id === "notion-1")
      ?.toolCall.approvalConfirmationId,
    "confirmation-1",
  );
  const execute = after.model.toolCalls?.find((call) => call.id === "exec-1");
  assert.equal(
    getSandboxExecuteView({
      input: execute?.input,
      output: execute?.output,
      toolName: "execute",
    })?.output,
    "src\nsrc/index.ts\n",
  );
  assert.deepEqual(
    after.model.availableCitations.map((item) => item.chunkId),
    ["chunk-1", "chunk-2"],
  );
  assert.equal(
    JSON.stringify(after.model.availableCitations).includes("quoteText"),
    false,
  );

  // Structural reasoning parts and segments survive without their text.
  assert.deepEqual(
    after.version.traceParts
      ?.filter((part) => part.kind === "reasoning")
      .map((part) => [part.id, part.kind === "reasoning" ? part.text : null]),
    [
      ["model-reasoning:run-1:1", ""],
      ["model-reasoning:run-1:2", ""],
    ],
  );
  assert.deepEqual(
    after.version.modelReasoningSegments?.map((segment) => [
      segment.id,
      segment.text,
      segment.durationMs,
    ]),
    [
      ["model-reasoning:run-1:1", "", 1000],
      ["model-reasoning:run-1:2", "", 2000],
    ],
  );
  assert.equal(
    after.version.traceParts?.some(
      (part) => part.kind === "tool" && "input" in part,
    ),
    false,
  );
  // A legacy row's inline part input is still parsed (never preferred).
  assert.ok(
    before.version.traceParts?.every(
      (part) => part.kind !== "tool" || part.input !== undefined,
    ),
  );
});
