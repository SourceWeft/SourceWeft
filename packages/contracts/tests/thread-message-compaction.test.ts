import assert from "node:assert/strict";
import test from "node:test";
import {
  compactToolCallOperations,
  compactToolCallOutputsForClient,
  expandToolCallOperations,
  expandToolCallOutputsFromClient,
} from "../src/thread-message-compaction";

function operation(index: number) {
  return {
    result: { output: `stdout ${index}`, exitCode: 0 },
    status: "succeeded",
    createdAt: `2026-10-22T10:${String(10 + index).padStart(2, "0")}:00.000Z`,
    durationMs: 1000 + index,
    operationType: index === 0 ? "create" : "execute",
  };
}

function toolMessageOutput(index: number, operations: unknown[]) {
  const content = `{"status":"ok","step":${index}}\n\n[Command succeeded with exit code 0]`;
  return {
    name: "execute",
    type: "tool",
    status: "success",
    content,
    metadata: { versions: { "@langchain/core": "1.2.9" } },
    lc_kwargs: {
      id: `message-${index}`,
      name: "execute",
      status: "success",
      content,
      metadata: { versions: { "@langchain/core": "1.2.9" } },
      tool_call_id: `call-${index}`,
      additional_kwargs: {},
      response_metadata: {},
    },
    operations,
    lc_namespace: ["langchain_core", "messages"],
    tool_call_id: `call-${index}`,
    lc_serializable: true,
    additional_kwargs: {},
    response_metadata: {},
  };
}

/** Each sandbox call carries the message's timeline as of that call. */
function cumulativeRun(calls: number) {
  const timeline = Array.from({ length: calls + 1 }, (_, index) =>
    operation(index),
  );
  return {
    finishReason: "stop",
    toolCalls: [
      { id: "read", tool: "read_file", input: {}, output: { content: "x" } },
      ...Array.from({ length: calls }, (_, index) => ({
        id: `call-${index}`,
        tool: "execute",
        status: "completed",
        input: { command: `step ${index}` },
        output: toolMessageOutput(index, timeline.slice(0, index + 2)),
      })),
      { id: "failed", tool: "execute", status: "error", input: {} },
    ],
  };
}

const bytes = (value: unknown) => JSON.stringify(value).length;

test("tool-call outputs round-trip losslessly through the /messages compaction", () => {
  const metadata = cumulativeRun(20);
  const compacted = compactToolCallOutputsForClient(metadata);

  assert.deepEqual(expandToolCallOutputsFromClient(compacted), metadata);
  // 21 distinct operations instead of 230 copies, and no mirrored content.
  assert.equal((compacted.toolCallOperationPool as unknown[]).length, 21);
  assert.ok(bytes(compacted) < bytes(metadata) / 2);
  const output = (
    compacted.toolCalls as Array<{ output?: Record<string, unknown> }>
  )[1]?.output;
  assert.deepEqual(output?.operationRefs, [0, 1]);
  assert.equal("operations" in (output ?? {}), false);
  // Only the mirrored keys move; the ToolMessage's own id stays.
  assert.deepEqual(output?.lc_kwargs, { id: "message-0" });
  assert.deepEqual(output?.lcKwargsMirrored, [
    "name",
    "status",
    "content",
    "metadata",
    "tool_call_id",
    "additional_kwargs",
    "response_metadata",
  ]);
});

test("operations stay inline when no call repeats another's", () => {
  const metadata = {
    toolCalls: [
      {
        id: "only",
        tool: "execute",
        output: { content: "done", operations: [operation(0), operation(1)] },
      },
    ],
  };
  const compacted = compactToolCallOutputsForClient(metadata);

  assert.deepEqual(compacted, metadata);
  assert.deepEqual(expandToolCallOutputsFromClient(compacted), metadata);
});

test("lc_kwargs keys that differ from the output stay in lc_kwargs", () => {
  const metadata = {
    toolCalls: [
      {
        id: "a",
        tool: "execute",
        output: {
          content: "new",
          lc_kwargs: { content: "old", status: "success" },
          status: "success",
        },
      },
    ],
  };
  const compacted = compactToolCallOutputsForClient(metadata);
  const output = (compacted.toolCalls as Array<{ output: unknown }>)[0]?.output;

  assert.deepEqual(output, {
    content: "new",
    lc_kwargs: { content: "old" },
    status: "success",
    lcKwargsMirrored: ["status"],
  });
  assert.deepEqual(expandToolCallOutputsFromClient(compacted), metadata);
});

test("expansion leaves uncompacted and malformed metadata as it is", () => {
  const stored = cumulativeRun(3);
  assert.deepEqual(expandToolCallOutputsFromClient(stored), stored);

  const malformed = {
    toolCallOperationPool: [operation(0)],
    toolCalls: [
      {
        id: "a",
        tool: "execute",
        output: { content: "x", operationRefs: [0, 7] },
      },
    ],
  };
  assert.deepEqual(expandToolCallOutputsFromClient(malformed), {
    toolCalls: malformed.toolCalls,
  });
  assert.deepEqual(expandToolCallOutputsFromClient({ content: "no calls" }), {
    content: "no calls",
  });
});

test("expanded operations are independent copies of the pooled entry", () => {
  const expanded = expandToolCallOutputsFromClient(
    compactToolCallOutputsForClient(cumulativeRun(2)),
  );
  const calls = expanded.toolCalls as Array<{
    output?: { operations?: Array<{ status: string }> };
  }>;
  const first = calls[1]?.output?.operations?.[0];
  const second = calls[2]?.output?.operations?.[0];
  assert.ok(first && second);
  assert.notEqual(first, second);
  first.status = "mutated";
  assert.equal(second.status, "succeeded");
});

test("stored operations pool once per record and expand to the written shape", () => {
  const snapshot = { status: "running", ...cumulativeRun(40) };
  const stored = compactToolCallOperations(snapshot);

  assert.equal((stored.toolCallOperationPool as unknown[]).length, 41);
  // Storage pools operations only; mirrored lc_kwargs stay as written.
  const output = (
    stored.toolCalls as Array<{ output?: Record<string, unknown> }>
  )[1]?.output;
  assert.equal("lcKwargsMirrored" in (output ?? {}), false);
  assert.deepEqual(expandToolCallOperations(stored), snapshot);
  assert.ok(bytes(stored) < bytes(snapshot) / 4);
});

test("re-compacting a stored record is idempotent, including newly inline calls", () => {
  const stored = compactToolCallOperations(cumulativeRun(5));
  assert.deepEqual(compactToolCallOperations(stored), stored);

  // A writer that spread a stored record and appended an expanded call.
  const appended = {
    ...stored,
    toolCalls: [
      ...(stored.toolCalls as unknown[]),
      {
        id: "call-new",
        tool: "execute",
        output: toolMessageOutput(9, [operation(0), operation(9)]),
      },
    ],
  };
  const expected = {
    ...cumulativeRun(5),
    toolCalls: [
      ...cumulativeRun(5).toolCalls,
      {
        id: "call-new",
        tool: "execute",
        output: toolMessageOutput(9, [operation(0), operation(9)]),
      },
    ],
  };
  assert.deepEqual(
    expandToolCallOperations(compactToolCallOperations(appended)),
    expected,
  );
});

test("records without a pool are returned as they are", () => {
  const legacy = cumulativeRun(2);
  assert.equal(expandToolCallOperations(legacy), legacy);
  assert.deepEqual(compactToolCallOperations({ status: "queued" }), {
    status: "queued",
  });
});
