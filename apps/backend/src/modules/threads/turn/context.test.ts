import assert from "node:assert/strict";
import { test, vi } from "vitest";

vi.mock("../../workspace/guards", () => ({
  requireContentWorkspace: vi.fn(),
}));

vi.mock("../thread/repository", () => ({
  findThreadRecord: vi.fn(),
}));

vi.mock("../message-repository", () => ({
  listMessageRecordsByThread: vi.fn(),
}));

import {
  filterMessagesBeforeEditAnchor,
  isContextExcludedMessage,
  resolveAgentCheckpointMetadata,
  resolveTurnOptionsToolsFromMessage,
  resolveMentionedSourceIdsFromMessage,
  resolveSourceIdsFromMessage,
} from "./context";
import {
  readWebAccessOverride,
  resolveGenerateImageToolSelection,
} from "./tool-selection";
import type { MessageRecord } from "../../content/types";

function message(
  metadata: Record<string, unknown>,
  overrides: Partial<MessageRecord> = {},
): MessageRecord {
  return {
    id: overrides.id ?? "message-1",
    teamId: "team-1",
    workspaceId: "workspace-1",
    threadId: "thread-1",
    parentMessageId: overrides.parentMessageId ?? null,
    role: overrides.role ?? "user",
    content: overrides.content ?? "hello",
    metadata,
    createdBy: overrides.createdBy ?? "user-1",
    model: overrides.model ?? null,
    creditsConsumed: overrides.creditsConsumed ?? null,
    contentJson: overrides.contentJson ?? {},
    createdAt: overrides.createdAt ?? new Date().toISOString(),
  };
}

test("resolveSourceIdsFromMessage reads source ids", () => {
  assert.deepEqual(
    resolveSourceIdsFromMessage(
      message({
        sourceIds: ["source-from-message"],
      }),
    ),
    ["source-from-message"],
  );
});

test("resolveSourceIdsFromMessage filters invalid values", () => {
  assert.deepEqual(
    resolveSourceIdsFromMessage(message({ sourceIds: ["source-1", "", 1] })),
    ["source-1"],
  );
});

test("resolveMentionedSourceIdsFromMessage reads mentioned source ids", () => {
  assert.deepEqual(
    resolveMentionedSourceIdsFromMessage(
      message({
        mentionedSourceIds: ["mentioned-source"],
      }),
    ),
    ["mentioned-source"],
  );
});

test("resolveMentionedSourceIdsFromMessage filters invalid values", () => {
  assert.deepEqual(
    resolveMentionedSourceIdsFromMessage(
      message({ mentionedSourceIds: ["source-1", "", 1] }),
    ),
    ["source-1"],
  );
});

test("resolveTurnOptionsToolsFromMessage reads options snapshot only", () => {
  assert.deepEqual(
    resolveTurnOptionsToolsFromMessage(
      message({
        options: {
          version: 1,
          tools: { web_search: { enabled: true } },
        },
        tools: { web_search: { enabled: false } },
      }),
    ),
    { web_search: { enabled: true } },
  );
  assert.equal(
    resolveTurnOptionsToolsFromMessage(
      message({ tools: { web_search: { enabled: true } } }),
    ),
    undefined,
  );
});

test("turn options snapshot can be interpreted as request-shaped web tools", () => {
  assert.equal(
    readWebAccessOverride(
      resolveTurnOptionsToolsFromMessage(
        message({
          options: {
            version: 1,
            tools: { web_search: { enabled: true } },
          },
        }),
      ),
    ),
    true,
  );
  assert.equal(
    readWebAccessOverride(
      resolveTurnOptionsToolsFromMessage(
        message({
          options: {
            version: 1,
            tools: { web_fetch: { enabled: true } },
          },
        }),
      ),
    ),
    true,
  );
  assert.equal(
    readWebAccessOverride(resolveTurnOptionsToolsFromMessage(message({}))),
    undefined,
  );
});

test("turn options snapshot can be interpreted as request-shaped image tools", () => {
  assert.deepEqual(
    resolveGenerateImageToolSelection(
      resolveTurnOptionsToolsFromMessage(
        message({
          options: {
            version: 1,
            tools: {
              generate_image: {
                enabled: false,
                modelAlias: "snapshot-image-model",
                config: { style: "cartoon" },
              },
            },
          },
        }),
      ),
    ),
    {
      enabled: false,
      modelAlias: "snapshot-image-model",
      config: { style: "cartoon" },
    },
  );
});

test("isContextExcludedMessage excludes persisted assistant errors", () => {
  assert.equal(
    isContextExcludedMessage(message({ isError: true }, { role: "assistant" })),
    true,
  );
  assert.equal(
    isContextExcludedMessage(
      message({ excludeFromContext: true }, { role: "assistant" }),
    ),
    true,
  );
  assert.equal(
    isContextExcludedMessage(message({}, { role: "assistant" })),
    false,
  );
});

test("filterMessagesBeforeEditAnchor drops the edited turn and later branch state", () => {
  const messages = [
    message(
      {},
      {
        id: "intro-user",
        role: "user",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ),
    message(
      {
        agentCheckpoint: {
          final: { threadId: "agent-thread", checkpointId: "intro-final" },
        },
      },
      {
        id: "intro-assistant",
        role: "assistant",
        createdAt: "2026-01-01T00:01:00.000Z",
      },
    ),
    message(
      { sourceIds: ["old-source"] },
      {
        id: "user-1",
        role: "user",
        createdAt: "2026-01-01T00:02:00.000Z",
      },
    ),
    message(
      {
        agentCheckpoint: {
          final: { threadId: "agent-thread", checkpointId: "old-final" },
        },
      },
      {
        id: "assistant-1",
        role: "assistant",
        createdAt: "2026-01-01T00:03:00.000Z",
      },
    ),
    message(
      { sourceIds: ["later-source"] },
      {
        id: "later-user",
        role: "user",
        createdAt: "2026-01-01T00:04:00.000Z",
      },
    ),
  ];

  assert.deepEqual(
    filterMessagesBeforeEditAnchor({
      anchorUserMessageId: "user-1",
      messages,
    }).map((item) => item.id),
    ["intro-user", "intro-assistant"],
  );
});

test("filterMessagesBeforeEditAnchor treats edited versions as their root turn", () => {
  const messages = [
    message({}, { id: "intro-user", role: "user" }),
    message({}, { id: "intro-assistant", role: "assistant" }),
    message({}, { id: "user-1", role: "user" }),
    message({}, { id: "assistant-1", role: "assistant" }),
    message(
      {},
      {
        id: "user-2",
        parentMessageId: "user-1",
        role: "user",
      },
    ),
    message(
      {},
      {
        id: "assistant-2",
        parentMessageId: "assistant-1",
        role: "assistant",
      },
    ),
  ];

  assert.deepEqual(
    filterMessagesBeforeEditAnchor({
      anchorUserMessageId: "user-2",
      messages,
    }).map((item) => item.id),
    ["intro-user", "intro-assistant"],
  );
});

test("resolveAgentCheckpointMetadata reads explicit checkpoint refs", () => {
  assert.deepEqual(
    resolveAgentCheckpointMetadata(
      message({
        agentCheckpoint: {
          beforeInput: {
            threadId: "thread-1",
            checkpointId: "checkpoint-before-input",
          },
          beforeAssistant: {
            threadId: "thread-1",
            checkpointId: "checkpoint-before-assistant",
            checkpointNs: "",
          },
          resume: {
            threadId: "thread-1",
            checkpointId: "checkpoint-resume",
          },
          final: {
            threadId: "thread-1",
            checkpointId: "checkpoint-final",
          },
        },
      }),
    ),
    {
      beforeInput: {
        threadId: "thread-1",
        checkpointId: "checkpoint-before-input",
      },
      beforeAssistant: {
        threadId: "thread-1",
        checkpointId: "checkpoint-before-assistant",
        checkpointNs: "",
      },
      resume: {
        threadId: "thread-1",
        checkpointId: "checkpoint-resume",
      },
      final: {
        threadId: "thread-1",
        checkpointId: "checkpoint-final",
      },
    },
  );
});

test("resolveAgentCheckpointMetadata maps legacy parent to beforeAssistant", () => {
  assert.deepEqual(
    resolveAgentCheckpointMetadata(
      message({
        agentCheckpoint: {
          parent: {
            threadId: "thread-1",
            checkpointId: "checkpoint-parent",
          },
          final: {
            threadId: "thread-1",
            checkpointId: "checkpoint-final",
          },
        },
      }),
    ),
    {
      beforeInput: null,
      beforeAssistant: {
        threadId: "thread-1",
        checkpointId: "checkpoint-parent",
      },
      resume: null,
      final: {
        threadId: "thread-1",
        checkpointId: "checkpoint-final",
      },
    },
  );
});
