import assert from "node:assert/strict";
import { test, vi } from "vitest";
import type { SelectedModels } from "../_components/model-catalog-utils";
import { buildStreamingThreadRequestBody } from "./streaming-request-body";

vi.mock("../_components/chat-canvas", () => ({
  buildChatToolsRequest: () => ({}),
}));

const selectedModels: SelectedModels = {
  image: null,
  llm: null,
  vision: null,
};

const thinkingSettings = {
  effort: "medium" as const,
  includeReasoning: true,
  mode: "auto" as const,
};

test("edit request body includes selected user and assistant message ids", () => {
  const body = buildStreamingThreadRequestBody({
    catalogKindEnabled: {},
    content: "Edited prompt",
    durableRunKey: "sourceweft-web-run:edit-1",
    mode: "edit",
    searchEnabled: false,
    selectedByokModels: {},
    selectedModels,
    streamWithSelectedLlm: false,
    thinkingSettings,
    userMessageId: "user-version-2",
    assistantMessageId: "assistant-version-2",
  });

  assert.equal(body.mode, "edit");
  assert.equal(body.content, "Edited prompt");
  assert.equal(body.userMessageId, "user-version-2");
  assert.equal(body.assistantMessageId, "assistant-version-2");
});

test("resume request body carries assistant id and DeepAgents resume payload without content", () => {
  const toolApprovalResume = {
    decisions: [{ type: "approve" as const }],
  };
  const body = buildStreamingThreadRequestBody({
    attachOnly: true,
    catalogKindEnabled: {},
    content: "Should not be resent",
    durableRunKey: "sourceweft-web-run:resume-1",
    mode: "resume",
    searchEnabled: false,
    selectedByokModels: {},
    selectedModels,
    streamWithSelectedLlm: false,
    thinkingSettings,
    assistantMessageId: "assistant-with-interrupt",
    toolApprovalResume,
  });

  assert.equal(body.mode, "resume");
  assert.equal(body.assistantMessageId, "assistant-with-interrupt");
  assert.equal(body.content, undefined);
  assert.equal(body.toolApprovalResume, toolApprovalResume);
});

test("non-resume request body rejects DeepAgents resume payloads", () => {
  assert.throws(
    () =>
      buildStreamingThreadRequestBody({
        catalogKindEnabled: {},
        durableRunKey: "sourceweft-web-run:refresh-1",
        mode: "refresh",
        searchEnabled: false,
        selectedByokModels: {},
        selectedModels,
        streamWithSelectedLlm: false,
        thinkingSettings,
        assistantMessageId: "assistant-with-interrupt",
        toolApprovalResume: {
          decisions: [{ type: "approve" }],
        },
      }),
    /toolApprovalResume requires resume mode/,
  );
});
