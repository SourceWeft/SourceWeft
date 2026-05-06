import assert from "node:assert/strict";
import test from "node:test";
import {
  isContextExcludedMessage,
  resolveAgentCheckpointMetadata,
  resolveWebSearchEnabledFromMessage,
  resolveSourceIdsFromMessage,
} from "./context";
import type { MessageRecord } from "../../types";

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

test("resolveWebSearchEnabledFromMessage reads tools schema flag only", () => {
  assert.equal(
    resolveWebSearchEnabledFromMessage(
      message({ tools: { webSearchEnabled: true } }),
    ),
    true,
  );
  assert.equal(
    resolveWebSearchEnabledFromMessage(message({ webSearchEnabled: true })),
    false,
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
      final: {
        threadId: "thread-1",
        checkpointId: "checkpoint-final",
      },
    },
  );
});
