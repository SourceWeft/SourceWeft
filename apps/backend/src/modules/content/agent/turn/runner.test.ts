import assert from "node:assert/strict";
import { test } from "vitest";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { testExports as agentTestExports } from "..";
import {
  normalizeGeneratedImageProgressEvent,
  normalizeToolOutputForObservability,
  testExports,
} from "./runner";
import type { ConnectorActionExecutionCursor } from "../../../connectors/agent-tool-idempotency";

test("normalizes read_file ToolMessage output content for observability", () => {
  const output = normalizeToolOutputForObservability("read_file", {
    type: "tool",
    lc_kwargs: {
      content: [{ text: "Path: /kb/invoice.md\nInvoice total is 50." }],
    },
    self: "[Circular]",
  });

  assert.deepEqual(output, {
    content: "Path: /kb/invoice.md\nInvoice total is 50.",
  });
});

test("preserves non-read_file tool outputs", () => {
  const output = { content: "search result", self: "[Circular]" };

  assert.equal(
    normalizeToolOutputForObservability("search_sources", output),
    output,
  );
});

test("sanitizes image blocks from persisted agent history", () => {
  const textOnly = new HumanMessage("hello");
  const imageMessage = new HumanMessage({
    content: [
      { type: "text", text: "what is this?" },
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,abcd" },
      },
    ],
  });
  const assistant = new AIMessage("answer");

  const result = agentTestExports.sanitizeMessagesForHistory([
    textOnly,
    imageMessage,
    assistant,
  ]);

  assert.equal(result.changed, true);
  assert.equal(result.messages[0], textOnly);
  assert.equal(result.messages[2], assistant);
  assert.deepEqual((result.messages[1] as HumanMessage).content, [
    { type: "text", text: "what is this?" },
    {
      type: "text",
      text: "[attached image 1: image, omitted from conversation history]",
    },
  ]);
});

test("normalizes web tool outputs to display-safe metadata", () => {
  const output = normalizeToolOutputForObservability(
    "web_search",
    "Use these web search results internally.\n\n<web_result id='c1' rank='1' url='https://example.com/a' title='A'>Snippet</web_result>",
  );

  assert.deepEqual(output, {
    resultCount: 1,
    urlCount: 1,
    urls: ["https://example.com/a"],
    pages: [
      {
        url: "https://example.com/a",
        title: "A",
        rank: 1,
        citation: "c1",
        hasContent: false,
      },
    ],
    truncated: false,
  });
  assert.equal(
    JSON.stringify(output).includes("Use these web search results internally"),
    false,
  );
});

test("normalizes web_search failure outputs to display-safe metadata", () => {
  const output = normalizeToolOutputForObservability(
    "web_search",
    "web_search failed.\n\n<web_tool_error tool='web_search' provider='anycrawl' query='Shanghai weather' error='API Error 500: Internal server error'></web_tool_error>",
  );

  assert.deepEqual(output, {
    errorCount: 1,
    error: "API Error 500: Internal server error",
    query: "Shanghai weather",
    urlCount: 0,
    urls: [],
    truncated: false,
  });
});

test("connector tool error outputs are preserved for tool error handling", () => {
  const output = normalizeToolOutputForObservability("create_notion_page", {
    type: "connector_tool_error",
    code: "NOTION_TARGET_NOT_FOUND",
    message: "The provided sourceId does not resolve to an indexed Notion page.",
    statusCode: 400,
  });

  assert.deepEqual(output, {
    type: "connector_tool_error",
    code: "NOTION_TARGET_NOT_FOUND",
    message: "The provided sourceId does not resolve to an indexed Notion page.",
    statusCode: 400,
  });
});

test("model reasoning segment ids include the run trace id", () => {
  assert.equal(
    testExports.createModelReasoningSegmentId({
      runTraceId: "trace-1",
      index: 2,
    }),
    "model-reasoning:trace-1:2",
  );
});

test("connector success outputs hide raw provider payloads", () => {
  const output = normalizeToolOutputForObservability("create_notion_page", {
    url: "https://www.notion.so/page",
    title: "服务器配置查询总结",
    pageId: "page-1",
    postActionSyncRunId: "sync-1",
    content: "private conversation summary",
  });

  assert.deepEqual(output, {
    type: "connector_tool_result",
    connector: "notion",
    toolName: "create_notion_page",
    title: "服务器配置查询总结",
    url: "https://www.notion.so/page",
    pageId: "page-1",
  });
});

test("connector search outputs preserve public result details", () => {
  const output = normalizeToolOutputForObservability("search_notion_pages", {
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
      {
        pageId: "page-2",
        title: "服务器部署",
        url: "https://www.notion.so/page-2",
      },
    ],
  });

  assert.deepEqual(output, {
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
      {
        pageId: "page-2",
        title: "服务器部署",
        url: "https://www.notion.so/page-2",
      },
    ],
  });
});

test("connector confirmation outputs hide editable request payloads", () => {
  const output = normalizeToolOutputForObservability("create_notion_page", {
    type: "tool",
    lc_kwargs: {
      content: JSON.stringify({
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
          requestJson: {
            title: "服务器配置查询总结",
            content: "private conversation summary",
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
      }),
    },
  });

  assert.equal(
    (output as Record<string, unknown>).type,
    "tool_confirmation_request",
  );
  assert.equal(
    "requestJson" in
      ((output as Record<string, unknown>).preview as Record<string, unknown>),
    false,
  );
  assert.equal("editableArgs" in (output as Record<string, unknown>), false);
});

test("connector approval mismatches are surfaced as content errors", () => {
  const error = testExports.getConnectorToolOutputContentError({
    type: "connector_tool_error",
    code: "CONNECTOR_ACTION_NOT_APPROVED",
    message:
      "Approved action was not found for this resumed tool call. Please retry the confirmation.",
    statusCode: 409,
  });

  assert.equal(error?.code, "CONNECTOR_ACTION_APPROVAL_MISMATCH");
  assert.equal(error?.statusCode, 409);
});

test("connector approval mismatches are detected inside ToolMessage content", () => {
  const error = testExports.getConnectorToolOutputContentError({
    type: "tool",
    lc_kwargs: {
      content: JSON.stringify({
        type: "connector_tool_error",
        code: "CONNECTOR_ACTION_NOT_APPROVED",
        message:
          "Approved action was not found for this resumed tool call. Please retry the confirmation.",
        statusCode: 409,
      }),
    },
  });

  assert.equal(error?.code, "CONNECTOR_ACTION_APPROVAL_MISMATCH");
});

test("connector approval mismatches are detected inside tool error text", () => {
  const error = testExports.getConnectorToolErrorTextContentError(
    "Error: Connector action must be approved before execution\n Please fix your mistakes.",
  );

  assert.equal(error?.code, "CONNECTOR_ACTION_APPROVAL_MISMATCH");
});

test("DeepAgents resume input excludes SourceWeft connector execution metadata", () => {
  assert.deepEqual(
    testExports.commandResumeFromToolApprovalResume({
      decisions: [{ type: "approve" }],
      sourceweft: {
        connectorActions: [
          {
            actionRunId: "action_1",
            connectorId: "connector_1",
            toolName: "create_notion_page",
          },
        ],
      },
    }),
    {
      decisions: [{ type: "approve" }],
    },
  );
});

test("DeepAgents HITL duplicate connector interrupts auto-resume from approved execution refs", () => {
  const actionExecutionCursor: ConnectorActionExecutionCursor = {
    refs: [
      {
        actionRunId: "delete-action",
        connectorId: "connector-1",
        requestJson: { pageId: "placeholder-page" },
        toolName: "delete_notion_page",
      },
    ],
    value: 0,
  };
  const context = {
    actionExecutionCursor,
  };

  assert.deepEqual(
    testExports.buildAutoApprovedHitlResumeDecisions({
      connectorContext: context,
      hitlInterrupts: [
        {
          actionRequests: [
            {
              args: { pageId: "placeholder-page" },
              name: "delete_notion_page",
            },
          ],
          reviewConfigs: [
            {
              actionName: "delete_notion_page",
              allowedDecisions: ["approve", "reject"],
            },
          ],
        },
      ],
    }),
    [{ type: "approve" }],
  );
  assert.equal(context.actionExecutionCursor.value, 0);
  assert.equal(context.actionExecutionCursor.consumedActionRunIds, undefined);
});

test("DeepAgents HITL auto-resume matches approved refs when replay adds undefined optional args", () => {
  assert.deepEqual(
    testExports.buildAutoApprovedHitlResumeDecisions({
      connectorContext: {
        actionExecutionCursor: {
          refs: [
            {
              actionRunId: "create-action",
              connectorId: "connector-1",
              requestJson: {
                title: "测试",
                content: "这是一个占位页面。",
                parentPageId: "367dadfc-4a0b-8026-996a-f6fd70dc6043",
              },
              toolName: "create_notion_page",
            },
          ],
          value: 0,
        },
      },
      hitlInterrupts: [
        {
          actionRequests: [
            {
              args: {
                title: "测试",
                content: "这是一个占位页面。",
                parentPageId: "367dadfc-4a0b-8026-996a-f6fd70dc6043",
                dataSourceId: undefined,
                pageId: undefined,
              },
              name: "create_notion_page",
            },
          ],
          reviewConfigs: [
            {
              actionName: "create_notion_page",
              allowedDecisions: ["approve", "reject"],
            },
          ],
        },
      ],
    }),
    [{ type: "approve" }],
  );
});

test("trace continuation keeps approval tool sequence and advances new events", () => {
  const allocator = testExports.createTraceSequenceAllocator({
    traceContinuation: {
      maxSequence: 4,
      toolSequenceById: {
        "approval-tool": 4,
      },
    },
  });

  assert.equal(allocator.resolveToolCallSequence("approval-tool"), 4);
  assert.equal(allocator.nextSequence(), 5);
  assert.equal(allocator.resolveToolCallSequence("new-tool"), 6);
  assert.equal(allocator.nextSequence(), 7);
});

test("DeepAgents HITL resume targets the persisted interrupt id when present", () => {
  assert.deepEqual(
    testExports.commandResumeFromToolApprovalResume({
      decisions: [{ type: "approve" }],
      sourceweft: {
        hitlInterruptId: "0123456789abcdef0123456789abcdef",
      },
    }),
    {
      "0123456789abcdef0123456789abcdef": {
        decisions: [{ type: "approve" }],
      },
    },
  );
});

test("DeepAgents auto-approved HITL resume targets the interrupt id when present", () => {
  assert.deepEqual(
    testExports.commandResumeFromHitlDecisions({
      decisions: [{ type: "approve" }],
      hitlInterruptId: "0123456789abcdef0123456789abcdef",
    }),
    {
      "0123456789abcdef0123456789abcdef": {
        decisions: [{ type: "approve" }],
      },
    },
  );
});

test("DeepAgents HITL auto-resume does not approve unmatched connector args", () => {
  assert.equal(
    testExports.buildAutoApprovedHitlResumeDecisions({
      connectorContext: {
        actionExecutionCursor: {
          refs: [
            {
              actionRunId: "delete-action",
              connectorId: "connector-1",
              requestJson: { pageId: "approved-page" },
              toolName: "delete_notion_page",
            },
          ],
          value: 0,
        },
      },
      hitlInterrupts: [
        {
          actionRequests: [
            {
              args: { pageId: "different-page" },
              name: "delete_notion_page",
            },
          ],
          reviewConfigs: [
            {
              actionName: "delete_notion_page",
              allowedDecisions: ["approve", "reject"],
            },
          ],
        },
      ],
    }),
    null,
  );
});

test("final assistant text stays empty for tool-only successful turns", () => {
  assert.equal(
    testExports.resolveFinalAssistantText({
      assistantContent: "",
      assistantContentFromUpdates: null,
      hasCompletedToolOutput: true,
    }),
    "",
  );
  assert.equal(
    testExports.resolveFinalAssistantText({
      assistantContent: "",
      assistantContentFromUpdates: null,
      hasCompletedToolOutput: false,
    }),
    "Model returned an empty response.",
  );
});

test("final assistant text can stay silent for rejected approval resumes", () => {
  assert.equal(
    testExports.resolveFinalAssistantText({
      assistantContent: "",
      assistantContentFromUpdates: null,
      hasCompletedToolOutput: false,
      allowSilentEmptyResponse: true,
    }),
    "",
  );
});

test("final assistant text prefers real assistant content over silent approval resume", () => {
  assert.equal(
    testExports.resolveFinalAssistantText({
      assistantContent: "The action was cancelled.",
      assistantContentFromUpdates: null,
      hasCompletedToolOutput: false,
      allowSilentEmptyResponse: true,
    }),
    "The action was cancelled.",
  );
  assert.equal(
    testExports.resolveFinalAssistantText({
      assistantContent: "",
      assistantContentFromUpdates: "The action was cancelled.",
      hasCompletedToolOutput: false,
      allowSilentEmptyResponse: true,
    }),
    "The action was cancelled.",
  );
});

test("rejected approval resume can silence empty continuations", () => {
  assert.equal(
    testExports.shouldSilenceEmptyApprovalResume({
      assistantMessageId: "assistant-message-1",
      hasCompletedToolOutput: false,
      toolApprovalResume: {
        decisions: [{ type: "reject", message: "User rejected the action." }],
      },
    }),
    true,
  );
});

test("approval resume silence requires reject decision and existing assistant message", () => {
  assert.equal(
    testExports.shouldSilenceEmptyApprovalResume({
      assistantMessageId: "assistant-message-1",
      hasCompletedToolOutput: false,
      toolApprovalResume: {
        decisions: [{ type: "approve" }],
      },
    }),
    false,
  );
  assert.equal(
    testExports.shouldSilenceEmptyApprovalResume({
      assistantMessageId: "assistant-message-1",
      hasCompletedToolOutput: false,
      toolApprovalResume: {
        decisions: [
          {
            type: "edit",
            editedAction: {
              name: "delete_notion_page",
              args: { pageId: "page-1" },
            },
          },
        ],
      },
    }),
    false,
  );
  assert.equal(
    testExports.shouldSilenceEmptyApprovalResume({
      assistantMessageId: null,
      hasCompletedToolOutput: false,
      toolApprovalResume: {
        decisions: [{ type: "reject" }],
      },
    }),
    false,
  );
  assert.equal(
    testExports.shouldSilenceEmptyApprovalResume({
      assistantMessageId: "assistant-message-1",
      hasCompletedToolOutput: true,
      toolApprovalResume: {
        decisions: [{ type: "reject" }],
      },
    }),
    false,
  );
});

test("HITL replay maps to the interrupted checkpoint without top-level checkpoint_id", () => {
  const config = testExports.resolveAgentBaseConfig({
    agentMode: "replay",
    agentRunThreadId: "unused-resume-thread",
    agentBaseCheckpoint: {
      threadId: "agent-thread-1",
      checkpointId: "interrupted-checkpoint",
      checkpointNs: "",
    },
  });

  assert.deepEqual(config, {
    configurable: {
      thread_id: "agent-thread-1",
      checkpoint_map: {
        "": "interrupted-checkpoint",
      },
      checkpoint_ns: "",
    },
  });
  assert.equal(
    "checkpoint_id" in config.configurable,
    false,
    "LangGraph keeps skipDoneTasks enabled only when checkpoint_id is not a top-level configurable key",
  );
});

test("HITL interrupt checkpoint prefers the current stream checkpoint when getState is stale", () => {
  const checkpoint = testExports.resolveHitlInterruptCheckpoint({
    pendingCheckpoint: {
      pending: false,
      checkpoint: {
        threadId: "agent-thread-1",
        checkpointId: "old-fork-base",
      },
    },
    observedCheckpoint: {
      threadId: "agent-thread-1",
      checkpointId: "current-interrupt",
    },
  });

  assert.deepEqual(checkpoint, {
    threadId: "agent-thread-1",
    checkpointId: "current-interrupt",
  });
});

test("HITL interrupt checkpoint uses pending getState checkpoint when available", () => {
  const checkpoint = testExports.resolveHitlInterruptCheckpoint({
    pendingCheckpoint: {
      pending: true,
      checkpoint: {
        threadId: "agent-thread-1",
        checkpointId: "pending-interrupt",
      },
    },
    observedCheckpoint: {
      threadId: "agent-thread-1",
      checkpointId: "current-interrupt",
    },
  });

  assert.deepEqual(checkpoint, {
    threadId: "agent-thread-1",
    checkpointId: "pending-interrupt",
  });
});

test("fork mode pins the requested checkpoint", () => {
  const config = testExports.resolveAgentBaseConfig({
    agentMode: "fork",
    agentRunThreadId: "unused-refresh-thread",
    agentBaseCheckpoint: {
      threadId: "agent-thread-1",
      checkpointId: "before-input",
    },
  });

  assert.deepEqual(config, {
    configurable: {
      thread_id: "agent-thread-1",
      checkpoint_id: "before-input",
      checkpoint_ns: "",
    },
  });
});

test("normalizes all-failed web_fetch outputs to display-safe metadata", () => {
  const output = normalizeToolOutputForObservability(
    "web_fetch",
    "<web_page rank='1' url='https://example.com' error='API Error 500: Internal server error'></web_page>",
  );

  assert.deepEqual(output, {
    pageCount: 1,
    errorCount: 1,
    urlCount: 1,
    urls: ["https://example.com"],
    pages: [
      {
        url: "https://example.com",
        rank: 1,
        error: "API Error 500: Internal server error",
        hasContent: true,
      },
    ],
    truncated: false,
  });
});

test("resolveToolCommand uses clean message content when display content has markers", () => {
  const command = testExports.resolveToolCommand({
    artifactIntent: {
      kind: "image",
      shouldInjectTool: true,
      source: "explicit_tool",
      confidence: 1,
      reason: "explicit tool",
      config: {
        aspectRatio: "auto",
        quality: "auto",
        style: "auto",
      },
      warnings: [],
    },
    command: {
      arguments: "",
      canonicalName: "/generate_image",
      description: "Generate image",
      displayName: "Generate image",
      kind: "tool",
      name: "/generate_image",
      skillSlug: "",
      toolName: "generate_image",
      workflow: {
        arguments: "",
        defaultTools: ["generate_image"],
        execution: "direct",
        kind: "tool_workflow",
        name: "/generate_image",
        permissionOverrides: {
          generate_image: "allow",
        },
        renderedPrompt: "",
        successCriteria: {
          artifactType: "image",
          kind: "artifact",
          toolName: "generate_image",
        },
      },
    },
    generateImageTool: {
      enabled: true,
      mode: "generate",
    },
    imageProfile: {
      capabilities: {
        controls: {},
        supported: true,
      },
      profile: {
        id: "profile-1",
        kind: "image",
        gatewayConfigId: "gateway-1",
        profileAlias: "image-default",
        modelAlias: "image-model",
        requestedDimensions: null,
        vectorStrategy: "disabled",
        isDefault: true,
        isActive: true,
        configJson: {},
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
    },
    messageContent: "draw a dashboard",
    userMessage: {
      content: "[tool:generate_image](Generate image) draw a dashboard",
    },
  } as unknown as Parameters<typeof testExports.resolveToolCommand>[0]);

  assert.deepEqual(command, {
    name: "generate_image",
    prompt: "draw a dashboard",
  });
});

test("command success requires generated image artifact metadata", () => {
  assert.equal(
    testExports.isCommandSuccessSatisfied({
      criteria: {
        artifactType: "image",
        kind: "artifact",
        toolName: "generate_image",
      },
      toolCalls: [
        {
          id: "tool-1",
          input: {},
          output: "Image artifact created.\nartifact_id: artifact-1",
          status: "completed",
          tool: "generate_image",
          latencyMs: 10,
          error: null,
          sequence: 1,
        },
      ],
    }),
    false,
  );
  assert.equal(
    testExports.isCommandSuccessSatisfied({
      criteria: {
        artifactType: "image",
        kind: "artifact",
        toolName: "generate_image",
      },
      toolCalls: [
        {
          id: "tool-1",
          input: {},
          output:
            "Image artifact created.\nartifact_id: artifact-1\nartifact_url: /v1/workspaces/workspace-1/artifacts/artifact-1/file",
          status: "completed",
          tool: "generate_image",
          latencyMs: 10,
          error: null,
          sequence: 1,
        },
      ],
    }),
    true,
  );
});

test("command retry instruction restates required tool completion", () => {
  assert.match(
    testExports.buildCommandRetryInstruction({
      kind: "tool_call",
      toolName: "search_notion_pages",
    }),
    /Retry now/,
  );
  assert.match(
    testExports.buildCommandRetryInstruction({
      kind: "tool_call",
      toolName: "search_notion_pages",
    }),
    /search_notion_pages/,
  );
});

test("filesystem tool titles classify glob scope from mounted pattern", () => {
  assert.equal(
    testExports.getFilesystemToolStartTitle("glob", {
      path: "/",
      pattern: "/work/**/*.md",
    }),
    "Finding matching Workfiles",
  );
  assert.equal(
    testExports.getFilesystemToolEndTitle("glob", {
      path: "/",
      pattern: "/skills/**/*.md",
    }),
    "Found matching skill files",
  );
  assert.equal(
    testExports.getFilesystemToolDescription(
      "read_file",
      { chunkCount: 1 },
      { path: "/work/notes.md" },
    ),
    "Read 1 Workfile chunk.",
  );
  assert.equal(
    testExports.getFilesystemToolDescription(
      "read_file",
      { chunkCount: 1 },
      { path: "/kb/source.md", limit: 100 },
    ),
    "Read up to 100 source lines.",
  );
});

test("runtime prompt maps selected source mention labels to kb paths", () => {
  const prompt = testExports.buildAgentRuntimePrompt({
    timezone: "UTC",
    availableWebTools: [],
    selectedSources: [
      {
        sourceId: "043e27f7-c8e0-438e-a47f-adcf8b06088e",
        sourceType: "file_upload",
        parentSourceId: null,
        title: "043e27f7-c8e0-438e-a47f-adcf8b06088e.pdf",
        fileName: "043e27f7-c8e0-438e-a47f-adcf8b06088e.pdf",
        safeName: "043e27f7-c8e0-438e-a47f-adcf8b06088e",
        shortId: "043e27f7",
        filePath: "/kb/043e27f7-c8e0-438e-a47f-adcf8b06088e__src_043e27f7.md",
        dirPath: "/kb/043e27f7-c8e0-438e-a47f-adcf8b06088e__src_043e27f7",
        readmePath: null,
        chunkCount: 4,
        sizeBytes: 12000,
        mimeType: "application/pdf",
        updatedAt: "2026-05-09T00:00:00.000Z",
      },
    ],
    selectedSourcesOmitted: 0,
  });

  assert.match(prompt, /<selected_source_manifest>/);
  assert.match(prompt, /@043e27f7-c8e0-438e-a47f-adcf8b06088e\.pdf/);
  assert.match(
    prompt,
    /kb_path="\/kb\/043e27f7-c8e0-438e-a47f-adcf8b06088e__src_043e27f7\.md"/,
  );
  assert.match(prompt, /Do not synthesize \/work\/<filename>/);
  assert.match(prompt, /\/work contains only thread Workfiles/);
});

test("runtime prompt lists only available public web tools", () => {
  const fetchOnlyPrompt = testExports.buildAgentRuntimePrompt({
    timezone: "UTC",
    availableWebTools: ["web_fetch"],
  });
  assert.match(
    fetchOnlyPrompt,
    /Available public web tools this turn: web_fetch\./,
  );
  assert.doesNotMatch(fetchOnlyPrompt, /web_search and web_fetch/);

  const searchAndFetchPrompt = testExports.buildAgentRuntimePrompt({
    timezone: "UTC",
    availableWebTools: ["web_search", "web_fetch"],
  });
  assert.match(
    searchAndFetchPrompt,
    /Available public web tools this turn: web_search, web_fetch\./,
  );
});

test("runtime prompt preloads slash-invoked skill instructions", () => {
  const prompt = testExports.buildAgentRuntimePrompt({
    timezone: "UTC",
    enabledSkills: [
      {
        workspaceSkillId: "skill-1",
        sourceType: "builtin",
        name: "feynman",
        version: "1.0.0",
        description: "Explain concepts in simple steps.",
        files: [
          {
            path: "SKILL.md",
            contentText:
              "Explain with simple analogies and check understanding.",
            mimeType: "text/markdown",
            sizeBytes: 40,
            contentHash: "hash",
          },
        ],
      },
    ],
    invokedSkillIds: ["skill-1"],
  });

  assert.match(prompt, /<user_invoked_skills>/);
  assert.match(prompt, /name="feynman"/);
  assert.match(prompt, /skill_path="\/skills\/feynman\/SKILL\.md"/);
  assert.match(prompt, /strong instruction, not a suggestion/);
  assert.match(
    prompt,
    /Explain with simple analogies and check understanding\./,
  );
});

test("extracts generated image artifacts from completed tool calls", () => {
  const artifacts = testExports.extractGeneratedImageArtifacts([
    {
      id: "tool-1",
      tool: "generate_image",
      input: {},
      output: {
        content:
          "Image artifact created.\nartifact_id: artifact-1\ntitle: Concept [draft]\nartifact_url: /v1/workspaces/workspace-1/artifacts/artifact-1/file",
      },
      sequence: 1,
      status: "completed",
      latencyMs: 100,
      error: null,
    },
  ]);

  assert.deepEqual(artifacts, [
    {
      artifactId: "artifact-1",
      artifactUrl: "/v1/workspaces/workspace-1/artifacts/artifact-1/file",
      title: "Concept [draft]",
      toolCallId: "tool-1",
    },
  ]);
});

test("normalizes generated image custom progress events", () => {
  assert.deepEqual(
    normalizeGeneratedImageProgressEvent({
      type: "generate_image_progress",
      toolCallId: "tool-1",
      tool: "web_search",
      stage: "generating",
    }),
    {
      toolCallId: "tool-1",
      tool: "generate_image",
      data: {
        type: "generate_image_progress",
        toolCallId: "tool-1",
        tool: "generate_image",
        stage: "generating",
      },
    },
  );

  assert.equal(
    normalizeGeneratedImageProgressEvent({
      type: "other_event",
      toolCallId: "tool-1",
    }),
    null,
  );
});

test("builds generated image render blocks in event order", () => {
  const builder = testExports.createMessageRenderBlockBuilder();

  builder.appendText("Intro\n");
  builder.appendGeneratedImage("tool-1");
  builder.appendText("\nDetails");

  assert.deepEqual(
    testExports.finalizeMessageRenderBlocks({
      blocks: builder.list(),
      finalText: "Intro\n\nDetails",
    }),
    [
      {
        id: "text-1",
        type: "text",
        text: "Intro\n",
      },
      {
        id: "generated-image-tool-1",
        type: "generated_image",
        toolCallId: "tool-1",
      },
      {
        id: "text-2",
        type: "text",
        text: "\nDetails",
      },
    ],
  );
});

test("drops render blocks when final text diverges", () => {
  const builder = testExports.createMessageRenderBlockBuilder();

  builder.appendText("Before citation [citation:missing]");
  builder.appendGeneratedImage("tool-1");

  assert.deepEqual(
    testExports.finalizeMessageRenderBlocks({
      blocks: builder.list(),
      finalText: "Before citation",
    }),
    [],
  );
});

test("runtime prompt treats image auto mode as available but optional", () => {
  const prompt = testExports.buildAgentRuntimePrompt({
    timezone: "UTC",
    availableArtifactTools: ["generate_image"],
    artifactIntent: {
      kind: "image",
      shouldInjectTool: true,
      source: "explicit_tool",
      confidence: 0.55,
      reason:
        "User-facing image generation controls configured generate_image.",
      config: {
        aspectRatio: "auto",
        quality: "auto",
        style: "auto",
      },
      warnings: [],
    },
  });

  assert.match(prompt, /generate_image is available in auto mode/);
  assert.match(prompt, /decide semantically from the user's goal/);
  assert.match(prompt, /Never claim an image was created/);
  assert.match(prompt, /do not include image markdown or raw artifact URLs/);
  assert.match(prompt, /otherwise answer normally/);
});
