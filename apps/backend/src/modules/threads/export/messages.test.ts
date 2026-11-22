import assert from "node:assert/strict";
import { test } from "vitest";
import type { MessageRecord } from "../../content/types";
import { collectMessageArtifactIds, selectExportMessages } from "./messages";

let clock = 0;
function message(
  id: string,
  overrides: Partial<MessageRecord> = {},
): MessageRecord {
  clock += 1;
  return {
    id,
    teamId: "org",
    workspaceId: "ws",
    threadId: "t",
    parentMessageId: null,
    role: "user",
    content: `text ${id}`,
    createdBy: "u1",
    model: null,
    creditsConsumed: null,
    contentJson: {},
    metadata: {},
    createdAt: new Date(Date.UTC(2026, 10, 1, 0, 0, clock)).toISOString(),
    ...overrides,
  };
}

function ids(messages: MessageRecord[]) {
  return messages.map((item) => item.id);
}

test("only the newest version of an edited message is kept", () => {
  const selected = selectExportMessages(
    [message("m1"), message("m2", { parentMessageId: "m1" })],
    null,
  );
  assert.deepEqual(ids(selected), ["m2"]);
});

test("system and tool messages are left out", () => {
  const selected = selectExportMessages(
    [
      message("s", { role: "system" }),
      message("t", { role: "tool" }),
      message("u"),
      message("a", { role: "assistant" }),
    ],
    null,
  );
  assert.deepEqual(ids(selected), ["u", "a"]);
});

test("error messages are left out", () => {
  const selected = selectExportMessages(
    [message("a", { role: "assistant", metadata: { isError: true } })],
    null,
  );
  assert.deepEqual(ids(selected), []);
});

test("the answer still being generated is left out", () => {
  const selected = selectExportMessages(
    [message("u"), message("a", { role: "assistant" })],
    "a",
  );
  assert.deepEqual(ids(selected), ["u"]);
});

test("empty messages are left out, but an image-only message is kept", () => {
  const selected = selectExportMessages(
    [
      message("empty", { role: "assistant", content: "  " }),
      message("img", {
        content: "",
        contentJson: {
          parts: [
            {
              type: "image",
              id: "i1",
              fileName: "chart.png",
              mimeType: "image/png",
              storageKey: "k",
              url: "/x",
            },
          ],
        },
      }),
    ],
    null,
  );
  assert.deepEqual(ids(selected), ["img"]);
});

test("an assistant message with only artifacts is kept", () => {
  const selected = selectExportMessages(
    [
      message("a", {
        role: "assistant",
        content: "",
        metadata: {
          renderBlocks: [{ type: "artifact_output", artifactId: "x" }],
        },
      }),
    ],
    null,
  );
  assert.deepEqual(ids(selected), ["a"]);
});

test("a stopped answer with text is kept", () => {
  const selected = selectExportMessages(
    [
      message("a", {
        role: "assistant",
        metadata: { isCancelled: true, excludeFromContext: true },
      }),
    ],
    null,
  );
  assert.deepEqual(ids(selected), ["a"]);
});

test("artifact ids come from render blocks and tool outputs, deduplicated", () => {
  assert.deepEqual(
    collectMessageArtifactIds({
      renderBlocks: [
        { type: "artifact_output", artifactId: "a1" },
        { type: "text", artifactId: "ignored" },
      ],
      toolCalls: [
        { output: '{"artifact_id":"a2"}' },
        { output: { artifactId: "a1" } },
        { output: "not json" },
        { output: null },
      ],
    }),
    ["a1", "a2"],
  );
  assert.deepEqual(collectMessageArtifactIds({}), []);
});
