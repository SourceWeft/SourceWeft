import assert from "node:assert/strict";
import { test, vi } from "vitest";

const state = vi.hoisted(() => ({
  written: [] as Record<string, unknown>[],
}));

vi.mock("../message-repository", () => ({
  createMessageRecord: vi.fn(async (input: Record<string, unknown>) => {
    state.written.push(input.metadata as Record<string, unknown>);
    return { id: "assistant-error-1", ...input };
  }),
  deleteMessageRecord: vi.fn(async () => undefined),
}));

import { ContentError } from "../../content/errors";
import { createThreadStreamErrorMessage } from "./error";
import type { PreparedThreadTurn } from "../turn/types";

test("persisted error turns keep reasoning segments as structure only", async () => {
  const segment = {
    id: "segment-1",
    text: "Partial thought.",
    sequence: 2,
    durationMs: 300,
    phase: "after_tool" as const,
    toolCallId: "tool-1",
    tool: "search_sources",
  };
  await createThreadStreamErrorMessage({
    prepared: {
      failurePersistence: "persist-error-turn",
      workspace: { id: "workspace-1", organizationId: "team-1" },
      thread: { id: "thread-1" },
      userMessage: { id: "user-message-1" },
      preflightBilling: [],
      modelAlias: "test-model",
      profileAlias: "default",
      agentMode: "default",
      assistantMessageParentId: "user-message-1",
      reasoningRun: { runId: "run-1", parentRunId: null, base: "" },
    } as unknown as PreparedThreadTurn,
    contentError: new ContentError(502, "MODEL_ERROR", "provider exploded"),
    partialAssistantContent: "Partial answer",
    partialState: {
      reasoning: "Partial thought.",
      reasoningSegments: [segment],
      traceParts: [
        {
          id: "segment-1",
          kind: "reasoning",
          order: 0,
          createdAt: "2026-05-25T00:00:00.000Z",
          updatedAt: "2026-05-25T00:00:00.000Z",
          phase: "after_tool",
        },
      ],
    },
  });

  const [metadata] = state.written;
  assert.ok(metadata);
  assert.deepEqual(metadata.reasoningSegments, [
    {
      id: "segment-1",
      sequence: 2,
      durationMs: 300,
      phase: "after_tool",
      toolCallId: "tool-1",
      tool: "search_sources",
    },
  ]);
  // `reasoning` keeps the text: it is the continuation base and the CAS key.
  assert.equal(metadata.reasoning, "Partial thought.");
  assert.equal(segment.text, "Partial thought.");
});
