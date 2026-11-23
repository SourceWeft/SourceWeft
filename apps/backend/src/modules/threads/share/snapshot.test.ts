import assert from "node:assert/strict";
import { test } from "vitest";
import type { MessageRecord } from "../../content/types";
import { buildChatSnapshot, type SnapshotArtifact } from "./snapshot";

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

const takenAt = new Date("2026-11-23T00:00:00Z");

function snapshot(
  messages: MessageRecord[],
  overrides: Partial<Parameters<typeof buildChatSnapshot>[0]> = {},
) {
  return buildChatSnapshot({
    title: "Chat",
    assistantName: null,
    takenAt,
    messages,
    activeAssistantMessageId: null,
    artifacts: new Map(),
    ...overrides,
  });
}

test("only the newest version of an edited message appears, and an error message is dropped", () => {
  const result = snapshot([
    message("m1"),
    message("m2", { parentMessageId: "m1" }),
    message("err", { role: "assistant", metadata: { isError: true } }),
  ]);
  assert.deepEqual(
    result.messages.map((m) => m.content),
    ["text m2"],
  );
});

test("a web citation becomes a numbered footnote with a url", () => {
  const result = snapshot([
    message("a", {
      role: "assistant",
      content: "See the report.[citation:c1]",
      metadata: {
        retrieval: {
          citations: [
            {
              citation: "c1",
              sourceTitle: "Report",
              externalUri: "https://example.com/r",
              excerpt: "some excerpt",
            },
          ],
        },
      },
    }),
  ]);
  assert.equal(result.messages[0]?.content, "See the report.[^1]");
  assert.deepEqual(result.messages[0]?.citations, [
    { n: 1, title: "Report", url: "https://example.com/r" },
  ]);
});

test("a private citation keeps its title only, and a missing title uses Source", () => {
  const result = snapshot([
    message("a", {
      role: "assistant",
      content: "From a file.[citation:c1]",
      metadata: {
        retrieval: {
          citations: [{ citation: "c1", excerpt: "private excerpt" }],
        },
      },
    }),
  ]);
  assert.deepEqual(result.messages[0]?.citations, [
    { n: 1, title: "Source", url: null },
  ]);
});

test("quotes and excerpts never appear in the snapshot", () => {
  const result = snapshot([
    message("a", {
      role: "assistant",
      content: "Cited.[citation:c1]",
      metadata: {
        retrieval: {
          citations: [
            {
              citation: "c1",
              sourceTitle: "Doc",
              support: "strong",
              spanText: "THE SPAN TEXT",
              excerpt: "THE EXCERPT TEXT",
            },
          ],
        },
      },
    }),
  ]);
  const json = JSON.stringify(result);
  assert.equal(json.includes("THE SPAN TEXT"), false);
  assert.equal(json.includes("THE EXCERPT TEXT"), false);
});

test("no member identity, tool output, reasoning, or model name crosses into the snapshot", () => {
  const result = snapshot([
    message("u", {
      role: "user",
      content: "Hi",
      createdBy: "user-1",
      model: "gpt-mystery",
      creditsConsumed: 42,
      metadata: {
        toolCalls: [{ name: "search", output: "TOOL OUTPUT SECRET" }],
        reasoning: "internal chain of thought",
        model: "gpt-mystery",
        creditsConsumed: 42,
        displayName: "Thans Realname",
      },
    }),
  ]);
  const json = JSON.stringify(result);
  for (const forbidden of [
    "user-1",
    "Thans Realname",
    "TOOL OUTPUT SECRET",
    "reasoning",
    "gpt-mystery",
  ]) {
    assert.equal(
      json.includes(forbidden),
      false,
      `must not include ${forbidden}`,
    );
  }
});

test("an attachment is recorded by bucket and key, and listed on the message", () => {
  const result = snapshot([
    message("u", {
      role: "user",
      content: "see",
      contentJson: {
        parts: [
          {
            type: "image",
            id: "i1",
            fileName: "chart.png",
            mimeType: "image/png",
            storageBucket: "bucket-1",
            storageKey: "key-1",
            url: "/x",
          },
        ],
      },
    }),
  ]);
  assert.deepEqual(result.images, [
    {
      n: 1,
      source: "attachment",
      bucket: "bucket-1",
      key: "key-1",
      mimeType: "image/png",
    },
  ]);
  assert.deepEqual(result.messages[0]?.images, [{ n: 1, name: "chart.png" }]);
});

test("a generated image referenced in the answer is placed in place, and recorded by artifact id", () => {
  const artifacts = new Map<string, SnapshotArtifact>([
    ["a9", { kind: "image", title: "cat.png", mimeType: "image/png" }],
  ]);
  const result = snapshot(
    [
      message("a", {
        role: "assistant",
        content: "Here:\n\n![x](/v1/workspaces/w/artifacts/a9/file)\n\nDone.",
        metadata: {
          renderBlocks: [{ type: "artifact_output", artifactId: "a9" }],
        },
      }),
    ],
    { artifacts },
  );
  assert.equal(
    result.messages[0]?.content,
    "Here:\n\n![cat.png](sw-image:1)\n\nDone.",
  );
  assert.deepEqual(result.images, [
    { n: 1, source: "artifact", artifactId: "a9", mimeType: "image/png" },
  ]);
  // Listed on the message too, so the public page's image allowlist admits
  // it; the page skips any listed image the content already shows.
  assert.deepEqual(result.messages[0]?.images, [{ n: 1, name: "cat.png" }]);
});

test("a generated image without a reference goes to images only", () => {
  const artifacts = new Map<string, SnapshotArtifact>([
    ["a9", { kind: "image", title: "cat.png", mimeType: "image/png" }],
  ]);
  const result = snapshot(
    [
      message("a", {
        role: "assistant",
        content: "Made it.",
        metadata: {
          renderBlocks: [{ type: "artifact_output", artifactId: "a9" }],
        },
      }),
    ],
    { artifacts },
  );
  assert.equal(result.messages[0]?.content, "Made it.");
  assert.deepEqual(result.images, [
    { n: 1, source: "artifact", artifactId: "a9", mimeType: "image/png" },
  ]);
  assert.deepEqual(result.messages[0]?.images, [{ n: 1, name: "cat.png" }]);
});

test("a non-image artifact becomes an artifact card; an id missing from the map is ignored", () => {
  const artifacts = new Map<string, SnapshotArtifact>([
    ["a1", { kind: "report", title: "Q3 summary", mimeType: null }],
  ]);
  const result = snapshot(
    [
      message("a", {
        role: "assistant",
        content: "Done.",
        metadata: {
          renderBlocks: [
            { type: "artifact_output", artifactId: "a1" },
            { type: "artifact_output", artifactId: "missing" },
          ],
        },
      }),
    ],
    { artifacts },
  );
  assert.deepEqual(result.messages[0]?.artifacts, [
    { artifactId: "a1", kind: "report", title: "Q3 summary" },
  ]);
});

test("stopped follows metadata.isCancelled, and a marker inside a code block stays", () => {
  const result = snapshot([
    message("a", {
      role: "assistant",
      content: "Partial `[citation:c1]` text",
      metadata: { isCancelled: true },
    }),
  ]);
  assert.equal(result.messages[0]?.stopped, true);
  assert.equal(result.messages[0]?.content, "Partial `[citation:c1]` text");
});

test("an internal artifact image that was not placed never leaks the workspace or artifact id", () => {
  // "ws-secret-7" is not ready/viewable here (absent from the map), and
  // "art-query-9" is referenced through an artifactId= query URL.
  const result = snapshot([
    message("a", {
      role: "assistant",
      content: [
        "Before",
        "![chart](/v1/workspaces/ws-secret-7/artifacts/art-missing-3/file)",
        "middle",
        "![other](https://api.test/v1/files?workspaceId=ws-secret-7&artifactId=art-query-9)",
        "After",
      ].join("\n\n"),
      metadata: {
        renderBlocks: [
          { type: "artifact_output", artifactId: "art-missing-3" },
        ],
      },
    }),
  ]);

  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("ws-secret-7"), serialized);
  assert.ok(!serialized.includes("art-missing-3"), serialized);
  assert.ok(!serialized.includes("art-query-9"), serialized);
  assert.equal(
    result.messages[0]?.content,
    "Before\n\nchart\n\nmiddle\n\nother\n\nAfter",
  );
});

test("an internal artifact link is reduced to its text, while code and external images stay", () => {
  const result = snapshot([
    message("a", {
      role: "assistant",
      content: [
        "[the report](/v1/workspaces/ws-secret-7/artifacts/art-1/download)",
        "![web](https://example.com/pic.png)",
        "`![x](/v1/workspaces/ws-code/artifacts/a/file)`",
      ].join("\n\n"),
    }),
  ]);

  const content = result.messages[0]?.content ?? "";
  assert.ok(!content.includes("ws-secret-7"), content);
  assert.ok(content.startsWith("the report\n\n"), content);
  assert.ok(content.includes("![web](https://example.com/pic.png)"), content);
  assert.ok(
    content.includes("`![x](/v1/workspaces/ws-code/artifacts/a/file)`"),
    content,
  );
});
