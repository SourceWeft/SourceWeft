import assert from "node:assert/strict";
import { test } from "vitest";
import type { ChatMessageItem } from "../streaming-assistant-state";
import { buildVersionedMessageGroups } from "./message-groups";
import {
  dropStaleActiveThreadRunMessages,
  findActiveThreadRunMessage,
  findLatestActiveThreadRunMessage,
  hasRenderBlocksMetadata,
  normalizeToolCallRecord,
  resolveRenderBlocksFromMetadata,
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
    'Error invoking tool \'generate_pptx\' with kwargs {"brief":"x","slides":[{"kind":"title"}]} with error: Error: Received tool input did not match expected schema\n\n✖ Invalid input: expected string, received undefined\n  → at title';
  const userMessage = createMessage({
    id: "user-1",
    role: "user",
    content: "Generate PPTX 生成费曼学习法的讲解PPT",
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
    "generate_pptx failed because the generated tool arguments were invalid. Please retry.",
  );
  assert.equal(
    error,
    "generate_pptx failed because the generated tool arguments were invalid. Please retry.",
  );
  assert.doesNotMatch(error ?? "", /kwargs|schema|brief|slides|expected string/i);
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
      (toolCall?.output as Record<string, unknown> | null)
        ?.preview as Record<string, unknown>
    )?.title,
    "Create Notion page: 服务器配置查询总结",
  );
  assert.equal(
    "requestJson" in
      ((toolCall?.output as Record<string, unknown> | null)
        ?.preview as Record<string, unknown>),
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
        group.versions.map((version, branchIndex) => [
          version.id,
          {
            branchIndex,
            groupId: group.groupId,
            version,
          },
        ] as const),
      ),
  );

  const entry = assistantVersionById.get("assistant-2");
  assert.equal(entry?.version.id, "assistant-2");
  assert.equal(entry?.version.threadRun?.id, "run-edit");
  assert.equal(entry?.branchIndex, 1);
});

test("old assistant messages without renderBlocks metadata preserve content and tool traces", () => {
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
      ],
    },
  });

  const version = buildVersionedMessageGroups([assistant])[0]?.versions[0];

  assert.equal(version?.content, "Old answer body remains visible.");
  assert.equal(version?.renderBlocks, undefined);
  assert.equal(version?.toolCalls?.[0]?.id, "tool-1");
  const tracePart = version?.traceParts?.[0];
  assert.equal(tracePart?.kind, "tool");
  assert.equal(tracePart?.kind === "tool" ? tracePart.toolCallId : undefined, "tool-1");
});

test("renderBlocks metadata presence is explicit", () => {
  assert.equal(hasRenderBlocksMetadata({}), false);
  assert.equal(hasRenderBlocksMetadata({ renderBlocks: "bad" }), false);
  assert.equal(hasRenderBlocksMetadata({ renderBlocks: [] }), true);
  assert.deepEqual(resolveRenderBlocksFromMetadata({ renderBlocks: [] }), []);
  assert.deepEqual(
    resolveRenderBlocksFromMetadata({
      renderBlocks: [{ id: "text-1", text: "Partial answer", type: "text" }],
    }),
    [{ id: "text-1", text: "Partial answer", type: "text" }],
  );
});

test("empty renderBlocks metadata does not remove interrupted assistant content", () => {
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
