import assert from "node:assert/strict";
import { test } from "vitest";
import {
  extractStreamableContent,
  handleToolArgDeltaChunk,
  type PartialToolArgStreamState,
} from "./tool-arg-stream-handler";
import type { TurnRuntime } from "./turn-runtime";

function makeRuntime() {
  const sequenceById = new Map<string, number>();
  let sequence = 0;
  return {
    partialToolArgsBySlot: new Map<string, PartialToolArgStreamState>(),
    toolCallsById: new Map<string, unknown>(),
    resolveToolCallSequence(id: string) {
      const existing = sequenceById.get(id);
      if (existing != null) {
        return existing;
      }
      sequence += 1;
      sequenceById.set(id, sequence);
      return sequence;
    },
  } as unknown as TurnRuntime;
}

function feed(
  runtime: TurnRuntime,
  delta: { index: number; id?: string; name?: string; args: string },
) {
  return [...handleToolArgDeltaChunk({ delta, runtime })];
}

test("extractStreamableContent reads write_file content, ignores others", () => {
  assert.equal(
    extractStreamableContent("write_file", { content: "abc" }),
    "abc",
  );
  assert.equal(extractStreamableContent("write_file", { path: "/x" }), null);
  assert.equal(extractStreamableContent("grep", { content: "abc" }), null);
});

test("streams growing write_file content across fragments", () => {
  const runtime = makeRuntime();
  const first = feed(runtime, {
    index: 0,
    id: "c1",
    name: "write_file",
    args: '{"path":"/workfiles/a.py","content":"pri',
  });
  assert.equal(first.length, 1);
  assert.equal(first[0]!.type, "tool-input-delta");
  if (first[0]!.type === "tool-input-delta") {
    assert.equal(first[0]!.id, "c1");
    assert.equal(first[0]!.tool, "write_file");
    assert.equal(first[0]!.input.content, "pri");
    assert.equal(first[0]!.input.path, "/workfiles/a.py");
  }

  const second = feed(runtime, { index: 0, args: 'nt(1)"}' });
  assert.equal(second.length, 1);
  if (second[0]!.type === "tool-input-delta") {
    assert.equal(second[0]!.input.content, "print(1)");
  }
});

test("does not emit until the tool-call id is known", () => {
  const runtime = makeRuntime();
  const before = feed(runtime, {
    index: 0,
    name: "write_file",
    args: '{"content":"x"',
  });
  assert.equal(before.length, 0);
  const after = feed(runtime, { index: 0, id: "c1", args: "" });
  assert.equal(after.length, 1);
});

test("ignores tools we do not stream", () => {
  const runtime = makeRuntime();
  const events = feed(runtime, {
    index: 0,
    id: "c1",
    name: "grep",
    args: '{"pattern":"x"}',
  });
  assert.equal(events.length, 0);
});

test("stops streaming once the authoritative call is promoted", () => {
  const runtime = makeRuntime();
  feed(runtime, {
    index: 0,
    id: "c1",
    name: "write_file",
    args: '{"content":"a',
  });
  (runtime.toolCallsById as Map<string, unknown>).set("c1", {});
  const events = feed(runtime, { index: 0, args: 'bc"}' });
  assert.equal(events.length, 0);
});

test("does not re-emit when content has not advanced", () => {
  const runtime = makeRuntime();
  feed(runtime, {
    index: 0,
    id: "c1",
    name: "write_file",
    args: '{"content":"abc"',
  });
  // A trailing fragment that adds no new content characters.
  const events = feed(runtime, { index: 0, args: "}" });
  assert.equal(events.length, 0);
});
