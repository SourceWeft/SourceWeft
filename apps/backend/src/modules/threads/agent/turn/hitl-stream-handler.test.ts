import assert from "node:assert/strict";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { AGENT_TOOL_NAMES } from "@sourceweft/agent-tool-registry";
import { beforeAll, test, vi } from "vitest";
import { connectorAdaptersReady } from "../../../connectors";
import { ContentError } from "../../../content/errors";
import { mcpService } from "../../../mcp";
import {
  collectHitlStreamResult,
  collectMessageStreamEvents,
} from "../../../../test/turn-stream-collectors";
import { createTurnRuntime } from "./turn-runtime";

async function* emptyAgentStream() {}

// Connector tools register through an async import-time side effect. The
// observability normalizer keys off that registry, so without awaiting it the
// connector cases below race the registration and see an unregistered tool.
beforeAll(async () => {
  await connectorAdaptersReady();
});

test("HITL stream handler records update tool calls and assistant content without interrupting", async () => {
  const runtime = createTurnRuntime({
    prepared: {
      runTraceId: "trace-hitl-updates",
      workspace: { id: "workspace" },
      thread: { id: "thread" },
    } as never,
  });

  const { events, result } = await collectHitlStreamResult({
    agent: { getState: vi.fn(), stream: vi.fn() } as never,
    autoApprovedHitlResumeCount: 0,
    beforeAssistantCheckpoint: null,
    beforeInputCheckpoint: null,
    connectorToolContext: {
      teamId: "team-1",
      workspaceId: "workspace-1",
      userId: "user-1",
    },
    finalCheckpoint: null,
    maxAutoApprovedHitlResumes: 1,
    payload: {
      agent: {
        messages: [
          {
            role: "assistant",
            content: "Draft answer from updates.",
            tool_calls: [
              {
                id: "call-search-updates",
                name: "search_sources",
                args: { query: "updates" },
              },
            ],
          },
        ],
      },
    },
    runConfig: {} as never,
    runtime,
    threadId: "thread-1",
    userId: "user-1",
    workspaceId: "workspace-1",
  });

  assert.deepEqual(events, []);
  assert.deepEqual(result, { kind: "continue" });
  assert.equal(
    runtime.assistantContentFromUpdates,
    "Draft answer from updates.",
  );
  assert.deepEqual(runtime.observedToolCallsById.get("call-search-updates"), {
    id: "call-search-updates",
    name: "search_sources",
    args: { query: "updates" },
    index: 0,
  });
});

test("HITL stream handler records LangChain AIMessage update content", async () => {
  const runtime = createTurnRuntime({
    prepared: {
      runTraceId: "trace-hitl-langchain-ai-message",
      workspace: { id: "workspace" },
      thread: { id: "thread" },
    } as never,
  });

  const { events, result } = await collectHitlStreamResult({
    agent: { getState: vi.fn(), stream: vi.fn() } as never,
    autoApprovedHitlResumeCount: 0,
    beforeAssistantCheckpoint: null,
    beforeInputCheckpoint: null,
    connectorToolContext: {
      teamId: "team-1",
      workspaceId: "workspace-1",
      userId: "user-1",
    },
    finalCheckpoint: null,
    maxAutoApprovedHitlResumes: 1,
    payload: {
      agent: {
        messages: [new AIMessage("LangChain answer from updates.")],
      },
    },
    runConfig: {} as never,
    runtime,
    threadId: "thread-1",
    userId: "user-1",
    workspaceId: "workspace-1",
  });

  assert.deepEqual(events, []);
  assert.deepEqual(result, { kind: "continue" });
  assert.equal(
    runtime.assistantContentFromUpdates,
    "LangChain answer from updates.",
  );
});

test("stream handlers ignore non-assistant messages", async () => {
  const updatesRuntime = createTurnRuntime({
    prepared: {
      runTraceId: "trace-hitl-non-assistant",
      workspace: { id: "workspace" },
      thread: { id: "thread" },
    } as never,
  });
  const updatesResult = await collectHitlStreamResult({
    agent: { getState: vi.fn(), stream: vi.fn() } as never,
    autoApprovedHitlResumeCount: 0,
    beforeAssistantCheckpoint: null,
    beforeInputCheckpoint: null,
    connectorToolContext: {
      teamId: "team-1",
      workspaceId: "workspace-1",
      userId: "user-1",
    },
    finalCheckpoint: null,
    maxAutoApprovedHitlResumes: 1,
    payload: {
      agent: {
        messages: [new HumanMessage("User text from updates.")],
      },
    },
    runConfig: {} as never,
    runtime: updatesRuntime,
    threadId: "thread-1",
    userId: "user-1",
    workspaceId: "workspace-1",
  });

  assert.deepEqual(updatesResult.events, []);
  assert.deepEqual(updatesResult.result, { kind: "continue" });
  assert.equal(updatesRuntime.assistantContentFromUpdates, null);

  const messagesRuntime = createTurnRuntime({
    prepared: {
      runTraceId: "trace-message-non-assistant",
      workspace: { id: "workspace" },
      thread: { id: "thread" },
    } as never,
  });
  const messageEvents = await collectMessageStreamEvents({
    payload: [new HumanMessage("User text from messages stream.")],
    commandSuccessCriteria: { kind: "none" },
    runtime: messagesRuntime,
    suppressModelReasoning: false,
  });

  assert.deepEqual(messageEvents, []);
  assert.equal(messagesRuntime.assistantContent, "");
  assert.equal(messagesRuntime.hasStreamedText, false);
});

test("HITL stream handler emits confirmation event sequence and interrupted final outcome", async () => {
  const runtime = createTurnRuntime({
    prepared: {
      runTraceId: "trace-hitl-confirmation",
      workspace: { id: "workspace" },
      thread: { id: "thread" },
    } as never,
  });
  runtime.assistantContent = "I need approval";
  runtime.hasTextSinceLastToolBoundary = true;
  runtime.renderBlocks.appendText("I need approval");
  const confirmation = {
    type: "tool_confirmation_request",
    schemaVersion: 1,
    id: "approval-1",
    domain: "mcp",
    subject: { label: "GitHub", provider: "mcp" },
    action: {
      type: "create_issue",
      toolName: "mcp__github__create_issue",
      label: "Create issue",
      riskLevel: "medium",
      status: "proposed",
      requiresApproval: true,
    },
    preview: {
      title: "Create issue",
      summary: "Create issue",
      requestJson: { title: "Ship task 5" },
    },
    execution: {
      providerStatus: "not_executed",
      executor: { kind: "mcp_action_run", actionRunId: "approval-1" },
    },
    status: "proposed",
    userMessage: "Waiting for confirmation.",
  } as never;
  const approvalMock = vi
    .spyOn(mcpService, "createApprovalForInterruptedTool")
    .mockResolvedValue(confirmation);

  try {
    const { events, result } = await collectHitlStreamResult({
      agent: {
        getState: vi.fn().mockResolvedValue({
          config: {
            configurable: {
              thread_id: "agent-thread-1",
              checkpoint_id: "pending-checkpoint",
              checkpoint_ns: "",
            },
          },
          values: {
            messages: [
              {
                role: "assistant",
                content: "Need approval",
                tool_calls: [
                  {
                    id: "call-approval",
                    name: "mcp__github__create_issue",
                    args: { title: "Ship task 5" },
                  },
                ],
              },
            ],
          },
          next: ["tools"],
        }),
        stream: vi.fn(),
      } as never,
      autoApprovedHitlResumeCount: 0,
      beforeAssistantCheckpoint: null,
      beforeInputCheckpoint: {
        threadId: "agent-thread-1",
        checkpointId: "before-input",
      },
      connectorToolContext: {
        teamId: "team-1",
        workspaceId: "workspace-1",
        userId: "user-1",
      },
      finalCheckpoint: {
        threadId: "agent-thread-1",
        checkpointId: "observed-checkpoint",
      },
      maxAutoApprovedHitlResumes: 1,
      payload: {
        __interrupt__: [
          {
            id: "interrupt-1",
            value: {
              actionRequests: [
                {
                  name: "mcp__github__create_issue",
                  args: { title: "Ship task 5" },
                },
              ],
              reviewConfigs: [
                {
                  actionName: "mcp__github__create_issue",
                  allowedDecisions: ["approve", "edit", "reject"],
                  argsSchema: { type: "object" },
                },
              ],
            },
          },
        ],
        agent: {
          messages: [
            {
              role: "assistant",
              content: "Need approval",
              tool_calls: [
                {
                  id: "call-approval",
                  name: "mcp__github__create_issue",
                  args: { title: "Ship task 5" },
                },
              ],
            },
          ],
        },
      },
      runConfig: {} as never,
      runtime,
      threadId: "thread-1",
      userId: "user-1",
      workspaceId: "workspace-1",
    });

    assert.deepEqual(
      events.map((event) => event.type),
      [
        "text-interrupted",
        "text-delta",
        "tool-call-start",
        "tool-call-result",
        "tool-call-end",
        "done",
      ],
    );
    assert.deepEqual(result, { kind: "done" });
    assert.equal(events[2]?.type, "tool-call-start");
    assert.equal(
      events[2]?.type === "tool-call-start" ? events[2].toolCall.status : null,
      "running",
    );
    assert.equal(events[3]?.type, "tool-call-result");
    assert.deepEqual(
      events[3]?.type === "tool-call-result"
        ? (events[3].output as { execution?: { sourceweft?: unknown } })
            .execution?.sourceweft
        : null,
      {
        hitlInterruptId: "interrupt-1",
        actionIndex: 0,
        toolName: "mcp__github__create_issue",
        requestJson: { title: "Ship task 5" },
        hitlActionIndex: 0,
        hitlActionToolName: "mcp__github__create_issue",
        hitlActionRequestJson: { title: "Ship task 5" },
        toolCallId: "hitl:interrupt-1:0:mcp__github__create_issue",
      },
    );
    assert.equal(events[5]?.type, "done");
    const outcome = events[5]?.type === "done" ? events[5].outcome : null;
    assert.equal(outcome?.finishReason, "tool_confirmation_requested");
    assert.equal(outcome?.assistantContent, "I need approval");
    assert.deepEqual(outcome?.agentCheckpoint, {
      beforeInput: {
        threadId: "agent-thread-1",
        checkpointId: "before-input",
      },
      beforeAssistant: {
        threadId: "agent-thread-1",
        checkpointId: "pending-checkpoint",
        checkpointNs: "",
      },
      resume: {
        threadId: "agent-thread-1",
        checkpointId: "pending-checkpoint",
        checkpointNs: "",
      },
      final: {
        threadId: "agent-thread-1",
        checkpointId: "pending-checkpoint",
        checkpointNs: "",
      },
    });
    assert.equal(
      approvalMock.mock.calls[0]?.[0].toolCallId,
      "hitl:interrupt-1:0:mcp__github__create_issue",
    );
  } finally {
    approvalMock.mockRestore();
  }
});

test("HITL stream handler binds MCP interrupts to a payload-derived ref without checkpoint correlation", async () => {
  const runtime = createTurnRuntime({
    prepared: {
      runTraceId: "trace-hitl-state-tool-call",
      workspace: { id: "workspace" },
      thread: { id: "thread" },
    } as never,
  });
  const confirmation = {
    type: "tool_confirmation_request",
    schemaVersion: 1,
    id: "approval-state-1",
    domain: "mcp",
    subject: { label: "GitHub", provider: "mcp" },
    action: {
      type: "create_issue",
      toolName: "mcp__github__create_issue",
      label: "Create issue",
      riskLevel: "medium",
      status: "proposed",
      requiresApproval: true,
    },
    preview: {
      title: "Create issue",
      summary: "Create issue",
      requestJson: { title: "Ship state task" },
    },
    execution: {
      providerStatus: "not_executed",
      executor: { kind: "mcp_action_run", actionRunId: "approval-state-1" },
    },
    status: "proposed",
    userMessage: "Waiting for confirmation.",
  } as never;
  const approvalMock = vi
    .spyOn(mcpService, "createApprovalForInterruptedTool")
    .mockResolvedValue(confirmation);

  try {
    const { events, result } = await collectHitlStreamResult({
      agent: {
        getState: vi.fn().mockResolvedValue({
          config: {
            configurable: {
              thread_id: "agent-thread-1",
              checkpoint_id: "pending-checkpoint",
              checkpoint_ns: "",
            },
          },
          next: ["tools"],
          values: {
            messages: [
              {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: "call-from-state",
                    name: "mcp__github__create_issue",
                    args: { title: "Ship state task" },
                  },
                ],
              },
            ],
          },
        }),
        stream: vi.fn(),
      } as never,
      autoApprovedHitlResumeCount: 0,
      beforeAssistantCheckpoint: null,
      beforeInputCheckpoint: null,
      connectorToolContext: {
        teamId: "team-1",
        workspaceId: "workspace-1",
        userId: "user-1",
      },
      finalCheckpoint: null,
      maxAutoApprovedHitlResumes: 1,
      payload: {
        __interrupt__: [
          {
            id: "interrupt-from-state",
            value: {
              actionRequests: [
                {
                  name: "mcp__github__create_issue",
                  args: { title: "Ship state task" },
                },
              ],
              reviewConfigs: [
                {
                  actionName: "mcp__github__create_issue",
                  allowedDecisions: ["approve", "edit", "reject"],
                },
              ],
            },
          },
        ],
      },
      runConfig: {} as never,
      runtime,
      threadId: "thread-1",
      userId: "user-1",
      workspaceId: "workspace-1",
    });

    assert.deepEqual(
      events.map((event) => event.type),
      ["tool-call-start", "tool-call-result", "tool-call-end", "done"],
    );
    assert.deepEqual(result, { kind: "done" });
    assert.equal(
      approvalMock.mock.calls[0]?.[0].toolCallId,
      "hitl:interrupt-from-state:0:mcp__github__create_issue",
    );
    assert.equal(events[0]?.type, "tool-call-start");
    assert.equal(
      events[0]?.type === "tool-call-start" ? events[0].id : null,
      "hitl:interrupt-from-state:0:mcp__github__create_issue",
    );
  } finally {
    approvalMock.mockRestore();
  }
});

test("HITL stream handler creates sandbox confirmation without connector or Daytona backend", async () => {
  const runtime = createTurnRuntime({
    prepared: {
      runTraceId: "trace-hitl-sandbox-confirmation",
      workspace: { id: "workspace" },
      thread: { id: "thread" },
    } as never,
  });

  const { events, result } = await collectHitlStreamResult({
    agent: {
      getState: vi.fn().mockResolvedValue({
        config: {
          configurable: {
            thread_id: "agent-thread-sandbox",
            checkpoint_id: "pending-sandbox-checkpoint",
            checkpoint_ns: "",
          },
        },
        values: {
          messages: [
            {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "call-sandbox-execute",
                  name: AGENT_TOOL_NAMES.execute,
                  args: {
                    command: "npm test",
                    workingDir: "/workspace/ppt-deck",
                  },
                },
              ],
            },
          ],
        },
        next: ["tools"],
      }),
      stream: vi.fn(),
    } as never,
    autoApprovedHitlResumeCount: 0,
    beforeAssistantCheckpoint: null,
    beforeInputCheckpoint: null,
    connectorToolContext: {
      teamId: "team-1",
      workspaceId: "workspace-1",
      userId: "user-1",
    },
    finalCheckpoint: null,
    maxAutoApprovedHitlResumes: 1,
    payload: {
      __interrupt__: [
        {
          id: "sandbox-interrupt-1",
          value: {
            actionRequests: [
              {
                name: AGENT_TOOL_NAMES.execute,
                args: {
                  command: "npm test",
                  workingDir: "/workspace/ppt-deck",
                },
                description: "Run tests in the sandbox runtime.",
              },
            ],
            reviewConfigs: [
              {
                actionName: AGENT_TOOL_NAMES.execute,
                allowedDecisions: ["approve", "edit", "reject"],
                argsSchema: { type: "object" },
              },
            ],
          },
        },
      ],
      agent: {
        messages: [
          {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call-sandbox-execute",
                name: AGENT_TOOL_NAMES.execute,
                args: {
                  command: "npm test",
                  workingDir: "/workspace/ppt-deck",
                },
              },
            ],
          },
        ],
      },
    },
    runConfig: {} as never,
    runtime,
    threadId: "thread-1",
    userId: "user-1",
    workspaceId: "workspace-1",
  });

  assert.deepEqual(
    events.map((event) => event.type),
    ["tool-call-start", "tool-call-result", "tool-call-end", "done"],
  );
  assert.deepEqual(result, { kind: "done" });
  assert.equal(events[1]?.type, "tool-call-result");
  const output =
    events[1]?.type === "tool-call-result"
      ? (events[1].output as Record<string, unknown>)
      : null;
  assert.equal(output?.type, "tool_confirmation_request");
  assert.equal(output?.domain, "sandbox");
  assert.deepEqual(
    (output?.execution as { sourceweft?: unknown } | undefined)?.sourceweft,
    {
      hitlInterruptId: "sandbox-interrupt-1",
      actionIndex: 0,
      toolName: AGENT_TOOL_NAMES.execute,
      requestJson: {
        command: "npm test",
        workingDir: "/workspace/ppt-deck",
      },
      hitlActionIndex: 0,
      hitlActionToolName: AGENT_TOOL_NAMES.execute,
      hitlActionRequestJson: {
        command: "npm test",
        workingDir: "/workspace/ppt-deck",
      },
      toolCallId: "hitl:sandbox-interrupt-1:0:execute",
    },
  );
  assert.deepEqual(
    (output?.editableArgs as { value?: unknown } | undefined)?.value,
    { command: "npm test", workingDir: "/workspace/ppt-deck" },
  );
  assert.equal(events[3]?.type, "done");
  const outcome = events[3]?.type === "done" ? events[3].outcome : null;
  assert.equal(outcome?.finishReason, "tool_confirmation_requested");
  assert.equal(outcome?.toolCalls[0]?.tool, AGENT_TOOL_NAMES.execute);
  assert.equal(outcome?.toolCalls[0]?.status, "approval_requested");
});

test("HITL stream handler returns replace-stream for auto-approved connector resume", async () => {
  const runtime = createTurnRuntime({
    prepared: {
      runTraceId: "trace-hitl-auto-resume",
      workspace: { id: "workspace" },
      thread: { id: "thread" },
    } as never,
  });
  const replacementStream = emptyAgentStream();
  let resumeCommand: unknown;
  const streamMock = vi.fn().mockImplementation((command: unknown) => {
    resumeCommand = command;
    return replacementStream;
  });
  const connectorToolContext = {
    actionExecutionCursor: {
      refs: [
        {
          actionRunId: "action-1",
          connectorId: "connector-1",
          requestJson: { pageId: "page-1" },
          toolName: "delete_notion_page",
        },
      ],
      value: 0,
    },
    actionApprovalScope: undefined as string | undefined,
    teamId: "team-1",
    workspaceId: "workspace-1",
    userId: "user-1",
  };

  const { events, result } = await collectHitlStreamResult({
    agent: {
      getState: vi.fn().mockResolvedValue(null),
      streamEvents: streamMock,
    } as never,
    autoApprovedHitlResumeCount: 0,
    beforeAssistantCheckpoint: null,
    beforeInputCheckpoint: null,
    connectorToolContext,
    finalCheckpoint: {
      threadId: "agent-thread-1",
      checkpointId: "observed-checkpoint",
    },
    maxAutoApprovedHitlResumes: 1,
    payload: {
      __interrupt__: [
        {
          id: "interrupt-1",
          value: {
            actionRequests: [
              {
                name: "delete_notion_page",
                args: { connectorId: "connector-1", pageId: "page-1" },
              },
            ],
            reviewConfigs: [
              {
                actionName: "delete_notion_page",
                allowedDecisions: ["approve", "reject"],
              },
            ],
          },
        },
      ],
    },
    runConfig: { configurable: { thread_id: "agent-thread-1" } } as never,
    runtime,
    threadId: "thread-1",
    userId: "user-1",
    workspaceId: "workspace-1",
  });

  assert.deepEqual(events, []);
  assert.equal(result.kind, "replace-stream");
  assert.equal(
    result.kind === "replace-stream" ? result.stream : null,
    replacementStream,
  );
  assert.equal(
    result.kind === "replace-stream"
      ? result.autoApprovedHitlResumeCount
      : null,
    1,
  );
  assert.deepEqual(
    result.kind === "replace-stream" ? result.finalCheckpoint : null,
    { threadId: "agent-thread-1", checkpointId: "observed-checkpoint" },
  );
  assert.equal(
    connectorToolContext.actionApprovalScope,
    "agent-thread-1:observed-checkpoint",
  );
  assert.equal(streamMock.mock.calls.length, 1);
  assert.deepEqual(
    (resumeCommand as { lg_name?: string; resume?: unknown }).resume,
    {
      "interrupt-1": {
        decisions: [{ type: "approve" }],
      },
    },
  );
});

test("HITL stream handler returns replace-stream for auto-approved sandbox resume", async () => {
  const runtime = createTurnRuntime({
    prepared: {
      runTraceId: "trace-hitl-auto-sandbox-resume",
      workspace: { id: "workspace" },
      thread: { id: "thread" },
    } as never,
  });
  const replacementStream = emptyAgentStream();
  let resumeCommand: unknown;
  const streamMock = vi.fn().mockImplementation((command: unknown) => {
    resumeCommand = command;
    return replacementStream;
  });

  const { events, result } = await collectHitlStreamResult({
    agent: {
      getState: vi.fn().mockResolvedValue({
        config: {
          configurable: {
            thread_id: "agent-thread-1",
            checkpoint_id: "pending-checkpoint",
            checkpoint_ns: "",
          },
        },
        values: {
          messages: [
            {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "call-sandbox-execute",
                  name: AGENT_TOOL_NAMES.execute,
                  args: { command: "npm test" },
                },
              ],
            },
          ],
        },
        next: ["tools"],
      }),
      streamEvents: streamMock,
    } as never,
    autoApprovedHitlResumeCount: 0,
    beforeAssistantCheckpoint: null,
    beforeInputCheckpoint: null,
    connectorToolContext: {
      sandboxActionExecutionCursor: {
        refs: [
          {
            requestJson: { command: "npm test" },
            toolCallId: "call-sandbox-execute",
            toolName: AGENT_TOOL_NAMES.execute,
          },
        ],
        value: 0,
      },
      teamId: "team-1",
      workspaceId: "workspace-1",
      userId: "user-1",
    },
    finalCheckpoint: {
      threadId: "agent-thread-1",
      checkpointId: "observed-checkpoint",
    },
    maxAutoApprovedHitlResumes: 1,
    payload: {
      __interrupt__: [
        {
          id: "sandbox-interrupt-1",
          value: {
            actionRequests: [
              {
                name: AGENT_TOOL_NAMES.execute,
                args: { command: "npm test" },
              },
            ],
            reviewConfigs: [
              {
                actionName: AGENT_TOOL_NAMES.execute,
                allowedDecisions: ["approve", "edit", "reject"],
              },
            ],
          },
        },
      ],
      agent: {
        messages: [
          {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call-sandbox-execute",
                name: AGENT_TOOL_NAMES.execute,
                args: { command: "npm test" },
              },
            ],
          },
        ],
      },
    },
    runConfig: { configurable: { thread_id: "agent-thread-1" } } as never,
    runtime,
    threadId: "thread-1",
    userId: "user-1",
    workspaceId: "workspace-1",
  });

  assert.deepEqual(events, []);
  assert.equal(result.kind, "replace-stream");
  assert.equal(
    result.kind === "replace-stream" ? result.stream : null,
    replacementStream,
  );
  assert.equal(streamMock.mock.calls.length, 1);
  assert.deepEqual(
    (resumeCommand as { lg_name?: string; resume?: unknown }).resume,
    {
      "sandbox-interrupt-1": {
        decisions: [{ type: "approve" }],
      },
    },
  );
});

test("HITL stream handler binds new confirmation from pending checkpoint, not payload tool calls", async () => {
  const runtime = createTurnRuntime({
    prepared: {
      runTraceId: "trace-hitl-pending-binding",
      workspace: { id: "workspace" },
      thread: { id: "thread" },
    } as never,
  });

  const { events, result } = await collectHitlStreamResult({
    agent: {
      getState: vi.fn().mockResolvedValue({
        config: {
          configurable: {
            thread_id: "agent-thread-1",
            checkpoint_id: "pending-checkpoint",
            checkpoint_ns: "",
          },
        },
        values: {
          messages: [
            {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "call-next-execute",
                  name: AGENT_TOOL_NAMES.execute,
                  args: { command: "npm test" },
                },
              ],
            },
          ],
        },
        next: ["tools"],
      }),
      stream: vi.fn(),
    } as never,
    autoApprovedHitlResumeCount: 0,
    beforeAssistantCheckpoint: null,
    beforeInputCheckpoint: null,
    connectorToolContext: {
      teamId: "team-1",
      workspaceId: "workspace-1",
      userId: "user-1",
    },
    finalCheckpoint: {
      threadId: "agent-thread-1",
      checkpointId: "observed-checkpoint",
    },
    maxAutoApprovedHitlResumes: 1,
    payload: {
      __interrupt__: [
        {
          id: "sandbox-interrupt-1",
          value: {
            actionRequests: [
              {
                name: AGENT_TOOL_NAMES.execute,
                args: { command: "npm test" },
              },
            ],
            reviewConfigs: [
              {
                actionName: AGENT_TOOL_NAMES.execute,
                allowedDecisions: ["approve", "edit", "reject"],
              },
            ],
          },
        },
      ],
      agent: {
        messages: [
          {
            role: "tool",
            name: "edit_file",
            tool_call_id: "call-previous-edit",
            content: "String not found",
          },
        ],
      },
    },
    runConfig: { configurable: { thread_id: "agent-thread-1" } } as never,
    runtime,
    threadId: "thread-1",
    userId: "user-1",
    workspaceId: "workspace-1",
  });

  assert.equal(result.kind, "done");
  assert.deepEqual(
    events.map((event) => event.type),
    ["tool-call-start", "tool-call-result", "tool-call-end", "done"],
  );
  const output =
    events[1]?.type === "tool-call-result"
      ? (events[1].output as Record<string, unknown>)
      : null;
  assert.equal(output?.id, "hitl:sandbox-interrupt-1:0:execute");
  assert.deepEqual(
    (output?.execution as { sourceweft?: unknown } | undefined)?.sourceweft,
    {
      hitlInterruptId: "sandbox-interrupt-1",
      actionIndex: 0,
      toolName: AGENT_TOOL_NAMES.execute,
      requestJson: { command: "npm test" },
      hitlActionIndex: 0,
      hitlActionToolName: AGENT_TOOL_NAMES.execute,
      hitlActionRequestJson: { command: "npm test" },
      toolCallId: "hitl:sandbox-interrupt-1:0:execute",
    },
  );
});

test("HITL stream handler auto-approves repeated sandbox action from persisted binding", async () => {
  const runtime = createTurnRuntime({
    prepared: {
      runTraceId: "trace-hitl-merge-sandbox-resume",
      workspace: { id: "workspace" },
      thread: { id: "thread" },
    } as never,
  });
  const replacementStream = emptyAgentStream();
  const streamMock = vi.fn();
  streamMock.mockReturnValue(replacementStream);

  const { events, result } = await collectHitlStreamResult({
    agent: {
      getState: vi.fn().mockResolvedValue(null),
      streamEvents: streamMock,
    } as never,
    autoApprovedHitlResumeCount: 0,
    beforeAssistantCheckpoint: null,
    beforeInputCheckpoint: null,
    connectorToolContext: {
      sandboxActionExecutionCursor: {
        refs: [
          {
            requestJson: { command: "npm test" },
            toolCallId: "call-approved-execute",
            toolName: AGENT_TOOL_NAMES.execute,
          },
        ],
        value: 0,
      },
      teamId: "team-1",
      workspaceId: "workspace-1",
      userId: "user-1",
    },
    finalCheckpoint: {
      threadId: "agent-thread-1",
      checkpointId: "observed-checkpoint",
    },
    maxAutoApprovedHitlResumes: 1,
    payload: {
      __interrupt__: [
        {
          id: "sandbox-interrupt-replayed",
          value: {
            actionRequests: [
              {
                name: AGENT_TOOL_NAMES.execute,
                args: { command: "npm test" },
              },
            ],
            reviewConfigs: [
              {
                actionName: AGENT_TOOL_NAMES.execute,
                allowedDecisions: ["approve", "edit", "reject"],
              },
            ],
          },
        },
      ],
    },
    runConfig: { configurable: { thread_id: "agent-thread-1" } } as never,
    runtime,
    threadId: "thread-1",
    userId: "user-1",
    workspaceId: "workspace-1",
  });

  assert.deepEqual(events, []);
  assert.equal(result.kind, "replace-stream");
  assert.equal(
    result.kind === "replace-stream" ? result.stream : null,
    replacementStream,
  );
  assert.equal(streamMock.mock.calls.length, 1);
});

test("HITL stream handler preserves missing checkpoint content error", async () => {
  const runtime = createTurnRuntime({
    prepared: {
      runTraceId: "trace-hitl-missing-checkpoint",
      workspace: { id: "workspace" },
      thread: { id: "thread" },
    } as never,
  });

  await assert.rejects(
    async () => {
      await collectHitlStreamResult({
        agent: {
          getState: vi.fn().mockResolvedValue(null),
          stream: vi.fn(),
        } as never,
        autoApprovedHitlResumeCount: 0,
        beforeAssistantCheckpoint: null,
        beforeInputCheckpoint: null,
        connectorToolContext: {
          teamId: "team-1",
          workspaceId: "workspace-1",
          userId: "user-1",
        },
        finalCheckpoint: null,
        maxAutoApprovedHitlResumes: 1,
        payload: {
          __interrupt__: [
            {
              value: {
                actionRequests: [
                  {
                    name: "delete_notion_page",
                    args: { pageId: "page-1" },
                  },
                ],
                reviewConfigs: [
                  {
                    actionName: "delete_notion_page",
                    allowedDecisions: ["approve", "reject"],
                  },
                ],
              },
            },
          ],
        },
        runConfig: {} as never,
        runtime,
        threadId: "thread-1",
        userId: "user-1",
        workspaceId: "workspace-1",
      });
    },
    (error: unknown) => {
      assert.equal(error instanceof ContentError, true);
      assert.equal((error as ContentError).statusCode, 500);
      assert.equal(
        (error as ContentError).code,
        "AGENT_HITL_TOOL_CALL_NOT_FOUND",
      );
      assert.equal(
        (error as ContentError).message,
        "DeepAgents HITL interrupt did not have a pending checkpoint to bind a confirmation tool call.",
      );
      return true;
    },
  );
});
