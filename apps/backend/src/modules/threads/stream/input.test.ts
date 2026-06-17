import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import type { MessageRecord } from "../../content/types";
import {
  resolveEditThreadStreamInput,
  resolveRefreshThreadStreamInput,
  resolveResumeThreadStreamInput,
  testExports,
} from "./input";

const workspace = {
  id: "workspace-1",
  organizationId: "team-1",
};

const thread = {
  id: "thread-1",
  teamId: "team-1",
  workspaceId: "workspace-1",
  title: "Thread",
  modelSettings: {},
  chatPreferences: {
    thinking: { mode: "auto", effort: "medium" },
    webAccess: true,
    composerOptions: {},
  },
  sourceCount: 0,
  createdBy: "user-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const mocks = vi.hoisted(() => ({
  listMessageRecordsByThread: vi.fn(),
}));

vi.mock("../../workspace/guards", () => ({
  requireContentWorkspace: vi.fn(async () => workspace),
}));

vi.mock("../thread/repository", () => ({
  findThreadRecord: vi.fn(async () => thread),
}));

vi.mock("../message-repository", () => ({
  listMessageRecordsByThread: mocks.listMessageRecordsByThread,
}));

vi.mock("../../skills/selection", () => ({
  normalizeSkillIds: (value: unknown) =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [],
}));

function message(
  role: MessageRecord["role"],
  overrides: Partial<MessageRecord> = {},
): MessageRecord {
  return {
    id: overrides.id ?? `${role}-message-1`,
    teamId: "team-1",
    workspaceId: "workspace-1",
    threadId: "thread-1",
    parentMessageId: overrides.parentMessageId ?? null,
    role,
    content: overrides.content ?? role,
    createdBy: role === "user" ? "user-1" : null,
    model: null,
    creditsConsumed: null,
    contentJson: overrides.contentJson ?? {},
    metadata: overrides.metadata ?? {},
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
  };
}

function snapshotTools() {
  return {
    version: 1,
    tools: {
      skillIds: ["snapshot-skill"],
      web_search: { enabled: true },
      web_fetch: { enabled: true },
    },
  };
}

function setThreadMessages(messages: MessageRecord[]) {
  mocks.listMessageRecordsByThread.mockResolvedValue(messages);
}

beforeEach(() => {
  mocks.listMessageRecordsByThread.mockReset();
});

test("refresh uses current request tools before the original turn snapshot", async () => {
  setThreadMessages([
    message("user", {
      id: "user-1",
      metadata: { options: snapshotTools() },
    }),
    message("assistant", { id: "assistant-1" }),
  ]);

  const input = await resolveRefreshThreadStreamInput({
    workspaceId: "workspace-1",
    threadId: "thread-1",
    userId: "user-1",
    tools: {
      skillIds: ["request-skill"],
      web_search: { enabled: false },
      web_fetch: { enabled: false },
    },
  });

  assert.deepEqual(input.tools, {
    skillIds: ["request-skill"],
    web_search: { enabled: false },
    web_fetch: { enabled: false },
  });
});

test("resume restores the original turn options snapshot", async () => {
  setThreadMessages([
    message("user", {
      id: "user-1",
      metadata: { options: snapshotTools() },
    }),
    message("assistant", {
      id: "assistant-1",
      metadata: {
        userMessageId: "user-1",
        agentCheckpoint: {
          resume: {
            threadId: "agent-thread-1",
            checkpointId: "checkpoint-1",
          },
        },
      },
    }),
  ]);

  const input = await resolveResumeThreadStreamInput({
    workspaceId: "workspace-1",
    threadId: "thread-1",
    userId: "user-1",
    assistantMessageId: "assistant-1",
    toolApprovalResume: {},
    tools: {
      skillIds: ["request-skill"],
      web_search: { enabled: false },
      web_fetch: { enabled: false },
    },
  });

  assert.deepEqual(input.tools, {
    skillIds: ["snapshot-skill"],
    web_search: { enabled: true },
    web_fetch: { enabled: true },
  });
});

test("edit keeps request skillIds when request tools are present", async () => {
  setThreadMessages([
    message("user", {
      id: "user-1",
      metadata: { options: snapshotTools(), skillIds: ["legacy-skill"] },
    }),
    message("assistant", {
      id: "assistant-1",
      metadata: {
        userMessageId: "user-1",
        agentCheckpoint: {
          final: {
            threadId: "agent-thread-1",
            checkpointId: "checkpoint-1",
          },
        },
      },
    }),
  ]);

  const input = await resolveEditThreadStreamInput({
    workspaceId: "workspace-1",
    threadId: "thread-1",
    userId: "user-1",
    content: "edited",
    tools: {
      skillIds: ["request-skill"],
      web_search: { enabled: false },
      web_fetch: { enabled: false },
    },
  });

  assert.deepEqual(input.tools, {
    skillIds: ["request-skill"],
    web_search: { enabled: false },
    web_fetch: { enabled: false },
  });
});

test("sandbox resume merge keeps explicit current action and ignores stale prior actions", () => {
  const resume = testExports.mergeToolApprovalResumeActions({
    priorConnectorActions: [],
    priorSandboxActions: [
      {
        toolName: "execute",
        toolCallId: "call-old",
        requestJson: { command: "npm test" },
        hitlInterruptId: "interrupt-old",
        sourceUserMessageId: "user-old",
        sourceAssistantMessageId: "assistant-old",
      },
    ],
    resume: {
      decisions: [{ type: "approve" }],
      sourceweft: {
        confirmationId: "confirmation-current",
        hitlInterruptId: "interrupt-current",
        sandboxExecuteToolCallId: "call-current",
        sourceUserMessageId: "user-current",
        sourceAssistantMessageId: "assistant-current",
        sandboxActions: [
          {
            toolName: "execute",
            toolCallId: "call-current",
            requestJson: { command: "pnpm test" },
            confirmationId: "confirmation-current",
            hitlInterruptId: "interrupt-current",
            sourceUserMessageId: "user-current",
            sourceAssistantMessageId: "assistant-current",
          },
        ],
      },
    },
  });

  assert.deepEqual(resume.sourceweft?.sandboxActions, [
    {
      toolName: "execute",
      toolCallId: "call-current",
      requestJson: { command: "pnpm test" },
      confirmationId: "confirmation-current",
      hitlInterruptId: "interrupt-current",
      sourceUserMessageId: "user-current",
      sourceAssistantMessageId: "assistant-current",
    },
  ]);
});

test("sandbox resume merge only uses legacy prior action when it matches current resume identity", () => {
  const matched = testExports.mergeToolApprovalResumeActions({
    priorConnectorActions: [],
    priorSandboxActions: [
      {
        toolName: "execute",
        toolCallId: "call-approved",
        requestJson: { command: "npm test" },
        hitlInterruptId: "interrupt-1",
        sourceUserMessageId: "user-1",
        sourceAssistantMessageId: "assistant-1",
      },
      {
        toolName: "execute",
        toolCallId: "call-stale",
        requestJson: { command: "npm test" },
        hitlInterruptId: "interrupt-stale",
        sourceUserMessageId: "user-stale",
        sourceAssistantMessageId: "assistant-stale",
      },
    ],
    resume: {
      decisions: [{ type: "approve" }],
      sourceweft: {
        hitlInterruptId: "interrupt-1",
        sandboxExecuteToolCallId: "call-approved",
        sourceUserMessageId: "user-1",
        sourceAssistantMessageId: "assistant-1",
      },
    },
  });

  assert.deepEqual(matched.sourceweft?.sandboxActions, [
    {
      toolName: "execute",
      toolCallId: "call-approved",
      requestJson: { command: "npm test" },
      hitlInterruptId: "interrupt-1",
      sourceUserMessageId: "user-1",
      sourceAssistantMessageId: "assistant-1",
    },
  ]);

  const unmatched = testExports.mergeToolApprovalResumeActions({
    priorConnectorActions: [],
    priorSandboxActions: matched.sourceweft?.sandboxActions ?? [],
    resume: {
      decisions: [{ type: "approve" }],
      sourceweft: {
        hitlInterruptId: "interrupt-2",
        sandboxExecuteToolCallId: "call-approved",
        sourceUserMessageId: "user-2",
        sourceAssistantMessageId: "assistant-2",
      },
    },
  });

  assert.equal(unmatched.sourceweft?.sandboxActions, undefined);
});

test("approved sandbox actions extracted from assistant metadata include source identity", () => {
  const actions = testExports.extractApprovedSandboxActionsFromMessage({
    id: "assistant-1",
    metadata: {
      userMessageId: "user-1",
      toolCalls: [
        {
          id: "trace-1",
          tool: "execute",
          approvalState: "approved",
          input: { command: "npm test" },
          output: {
            type: "tool_confirmation_request",
            id: "confirmation-1",
            status: "approved",
            action: { toolName: "execute" },
            preview: { requestJson: { command: "npm test" } },
            execution: {
              sourceweft: {
                hitlInterruptId: "interrupt-1",
                sandboxExecuteToolCallId: "call-execute",
              },
            },
          },
        },
      ],
    },
  });

  assert.deepEqual(actions, [
    {
      toolName: "execute",
      toolCallId: "call-execute",
      requestJson: { command: "npm test" },
      confirmationId: "confirmation-1",
      hitlInterruptId: "interrupt-1",
      sourceUserMessageId: "user-1",
      sourceAssistantMessageId: "assistant-1",
    },
  ]);
});
