import assert from "node:assert/strict";
import { test } from "vitest";
import type { MessageRecord } from "../content/types";
import { projectThreadMessageForClient } from "./message-client-view";

const mcpDisplay = { serverName: "Notion", toolName: "search" };

function message(
  role: MessageRecord["role"],
  metadata: Record<string, unknown>,
): MessageRecord {
  return {
    id: `${role}-1`,
    teamId: "team-1",
    workspaceId: "workspace-1",
    threadId: "thread-1",
    parentMessageId: null,
    role,
    content: "answer",
    createdBy: null,
    model: "test-model",
    creditsConsumed: 3,
    contentJson: {},
    metadata,
    createdAt: new Date(0).toISOString(),
  };
}

const citation = {
  citation: "c1",
  sourceId: "source-1",
  sourceTitle: "Invoice",
  documentId: "document-1",
  chunkId: "chunk-1",
  chunkNo: 0,
  score: 0.9,
  excerpt: "Invoice total is 50.",
  quoteText: "Invoice total is 50.",
  origin: "search_sources",
  path: "/sources/invoice.pdf",
};

function legacyAssistantMetadata(): Record<string, unknown> {
  return {
    finishReason: "stop",
    traceId: "trace-1",
    meteredLlmCalls: [{ spanId: "span-1", consumedCredits: 3 }],
    meteredLlmCreditsConsumed: 3,
    reasoning: "Need to search. Found it.",
    reasoningWrite: {
      runId: "run-1",
      parentRunId: null,
      base: "",
      revision: 4,
      terminal: true,
    },
    reasoningSegments: [
      { id: "segment-1", text: "Need to search.", sequence: 1 },
      {
        id: "segment-2",
        text: "Found it.",
        sequence: 3,
        phase: "after_tool",
        toolCallId: "search-1",
        tool: "notion_search",
        durationMs: 900,
      },
    ],
    renderBlocks: [
      { id: "reasoning-1", type: "reasoning", text: "Need to search." },
      { id: "text-1", type: "text", text: "answer" },
    ],
    traceEvents: [
      {
        type: "tool-call",
        id: "tool-call:search-1:2",
        itemId: "search-1",
        toolCall: { id: "search-1", tool: "notion_search", mcpDisplay },
      },
      {
        type: "tool-call",
        id: "tool-call:fetch-1:4",
        itemId: "fetch-1",
        payload: {
          toolCall: {
            id: "fetch-1",
            tool: "notion_fetch",
            mcpDisplay: { serverName: "Notion", toolName: "fetch" },
          },
        },
      },
    ],
    toolCalls: [
      {
        id: "search-1",
        tool: "notion_search",
        input: { query: "invoice" },
        output: { pages: 1 },
        status: "completed",
        sequence: 2,
      },
      {
        id: "fetch-1",
        tool: "notion_fetch",
        input: { id: "page-1" },
        output: { content: "page" },
        status: "completed",
        sequence: 4,
      },
    ],
    traceParts: [
      {
        id: "segment-1",
        kind: "reasoning",
        order: 0,
        createdAt: "2026-05-25T00:00:00.000Z",
        updatedAt: "2026-05-25T00:00:00.000Z",
        text: "Need to search.",
      },
      {
        id: "search-1",
        kind: "tool",
        order: 1,
        createdAt: "2026-05-25T00:00:01.000Z",
        updatedAt: "2026-05-25T00:00:01.000Z",
        toolCallId: "search-1",
        tool: "notion_search",
        status: "completed",
        input: { query: "invoice" },
      },
    ],
    retrieval: {
      embeddingProfileId: "profile-1",
      vectorStrategy: "hnsw",
      annIndexUsed: true,
      citations: [citation],
      availableCitations: [citation, { ...citation, citation: "c2" }],
    },
  };
}

test("assistant client view omits metering, reasoning, trace events and the write fence", () => {
  const view = projectThreadMessageForClient(
    message("assistant", legacyAssistantMetadata()),
  ).metadata;

  for (const key of [
    "meteredLlmCalls",
    "reasoning",
    "reasoningWrite",
    "traceEvents",
  ]) {
    assert.equal(Object.hasOwn(view, key), false, `${key} must be omitted`);
  }
  // Scalars and the rendered copies stay.
  assert.equal(view.finishReason, "stop");
  assert.equal(view.traceId, "trace-1");
  assert.equal(view.meteredLlmCreditsConsumed, 3);
  assert.deepEqual(view.renderBlocks, legacyAssistantMetadata().renderBlocks);
});

test("assistant client view backfills mcpDisplay from both trace event shapes before dropping them", () => {
  const view = projectThreadMessageForClient(
    message("assistant", legacyAssistantMetadata()),
  ).metadata;

  assert.deepEqual(
    (view.toolCalls as Record<string, unknown>[]).map((call) => [
      call.id,
      call.mcpDisplay,
    ]),
    [
      ["search-1", mcpDisplay],
      ["fetch-1", { serverName: "Notion", toolName: "fetch" }],
    ],
  );
  // Tool input and output stay on the canonical tool call.
  assert.deepEqual((view.toolCalls as Record<string, unknown>[])[0]?.input, {
    query: "invoice",
  });
});

test("assistant client view never backfills mcpDisplay across a tool mismatch or over a valid display", () => {
  const metadata = legacyAssistantMetadata();
  const ownDisplay = { serverName: "Own", toolName: "own" };
  metadata.toolCalls = [
    { id: "search-1", tool: "other_tool", input: {}, status: "completed" },
    {
      id: "fetch-1",
      tool: "notion_fetch",
      input: {},
      status: "completed",
      mcpDisplay: ownDisplay,
    },
    { id: "unknown-1", tool: "notion_search", input: {}, status: "completed" },
  ];
  const view = projectThreadMessageForClient(
    message("assistant", metadata),
  ).metadata;

  assert.deepEqual(
    (view.toolCalls as Record<string, unknown>[]).map(
      (call) => call.mcpDisplay,
    ),
    [undefined, ownDisplay, undefined],
  );
});

test("assistant client view strips legacy segment text, reasoning-part text and part input", () => {
  const view = projectThreadMessageForClient(
    message("assistant", legacyAssistantMetadata()),
  ).metadata;

  assert.deepEqual(view.reasoningSegments, [
    { id: "segment-1", sequence: 1 },
    {
      id: "segment-2",
      sequence: 3,
      phase: "after_tool",
      toolCallId: "search-1",
      tool: "notion_search",
      durationMs: 900,
    },
  ]);
  assert.deepEqual(view.traceParts, [
    {
      id: "segment-1",
      kind: "reasoning",
      order: 0,
      createdAt: "2026-05-25T00:00:00.000Z",
      updatedAt: "2026-05-25T00:00:00.000Z",
    },
    {
      id: "search-1",
      kind: "tool",
      order: 1,
      createdAt: "2026-05-25T00:00:01.000Z",
      updatedAt: "2026-05-25T00:00:01.000Z",
      toolCallId: "search-1",
      tool: "notion_search",
      status: "completed",
    },
  ]);
});

test("assistant client view drops quoteText from used and available citations", () => {
  const view = projectThreadMessageForClient(
    message("assistant", legacyAssistantMetadata()),
  ).metadata;
  const retrieval = view.retrieval as Record<string, unknown>;
  const { quoteText: _quoteText, ...citationView } = citation;

  assert.equal(retrieval.embeddingProfileId, "profile-1");
  assert.equal(retrieval.vectorStrategy, "hnsw");
  assert.equal(retrieval.annIndexUsed, true);
  assert.deepEqual(retrieval.citations, [citationView]);
  assert.deepEqual(retrieval.availableCitations, [
    citationView,
    { ...citationView, citation: "c2" },
  ]);
});

test("client view leaves stored metadata untouched", () => {
  const metadata = legacyAssistantMetadata();
  const before = structuredClone(metadata);
  projectThreadMessageForClient(message("assistant", metadata));
  assert.deepEqual(metadata, before);
});

test("non-assistant messages only get the shared client sanitizer", () => {
  const metadata = {
    reasoning: "kept",
    reasoningWrite: { runId: "run-1" },
    meteredLlmCalls: [{ spanId: "span-1" }],
    traceEvents: [{ id: "event-1" }],
    retrieval: { citations: [citation] },
    sourceIds: ["source-1"],
  };
  const view = projectThreadMessageForClient(
    message("user", metadata),
  ).metadata;

  const { reasoningWrite: _reasoningWrite, ...expected } = metadata;
  assert.deepEqual(view, expected);
});

test("assistant client view of a metadata-trimmed row keeps its shape", () => {
  // include=citations without metadata: only retrieval survives the trim.
  const view = projectThreadMessageForClient(
    message("assistant", { retrieval: { citations: [citation] } }),
  ).metadata;
  const { quoteText: _quoteText, ...citationView } = citation;
  assert.deepEqual(view, { retrieval: { citations: [citationView] } });
  assert.deepEqual(
    projectThreadMessageForClient(message("assistant", {})).metadata,
    {},
  );
});
