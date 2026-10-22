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
    args: '{"path":"/files/a.py","content":"pri',
  });
  assert.equal(first.length, 1);
  assert.equal(first[0]!.type, "tool-input-delta");
  if (first[0]!.type === "tool-input-delta") {
    assert.equal(first[0]!.id, "c1");
    assert.equal(first[0]!.tool, "write_file");
    assert.equal(first[0]!.input.content, "pri");
    assert.equal(first[0]!.input.path, "/files/a.py");
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

/** Content of each emitted `tool-input-delta`, with its call id. */
function contents(events: ReturnType<typeof feed>) {
  return events.flatMap((event) =>
    event.type === "tool-input-delta"
      ? [
          {
            id: event.id,
            toolCallId: event.toolCall.id,
            content: event.input.content,
          },
        ]
      : [],
  );
}

test("v3 cumulative block-deltas stream growing content without double concatenation (issue #335)", () => {
  // @langchain/core's v3 producers put the call's ACCUMULATED args on every
  // block-delta, with id and name on each one, keyed by the chunk's index.
  const runtime = makeRuntime();
  const snapshots = [
    '{"file_path":"/files/a.py",',
    '{"file_path":"/files/a.py","content":"pri',
    '{"file_path":"/files/a.py","content":"print(1)',
    '{"file_path":"/files/a.py","content":"print(1)"}',
  ];
  const emitted = snapshots.map((args) =>
    contents(feed(runtime, { index: 2, id: "c1", name: "write_file", args })),
  );
  assert.deepEqual(emitted, [
    [],
    [{ id: "c1", toolCallId: "c1", content: "pri" }],
    [{ id: "c1", toolCallId: "c1", content: "print(1)" }],
    [],
  ]);
  assert.equal(runtime.partialToolArgsBySlot.get("2")?.args, snapshots.at(-1));
});

test("true per-chunk deltas still accumulate by concatenation (issue #335)", () => {
  const runtime = makeRuntime();
  const fragments = [
    '{"file_path":"/files/a.py",',
    '"content":"pri',
    "nt(1)",
    '"}',
  ];
  const emitted = fragments.map((args, position) =>
    contents(
      feed(runtime, {
        index: 2,
        ...(position === 0 ? { id: "c1", name: "write_file" } : {}),
        args,
      }),
    ),
  );
  assert.deepEqual(emitted, [
    [],
    [{ id: "c1", toolCallId: "c1", content: "pri" }],
    [{ id: "c1", toolCallId: "c1", content: "print(1)" }],
    [],
  ]);
  assert.equal(
    runtime.partialToolArgsBySlot.get("2")?.args,
    fragments.join(""),
  );
});

test("a different call id on an occupied slot starts a fresh buffer under the new id (issue #335)", () => {
  // A later model call restarts block indexes, so its call lands on the slot
  // an earlier call used.
  const runtime = makeRuntime();
  feed(runtime, {
    index: 2,
    id: "c1",
    name: "write_file",
    args: '{"file_path":"/a.py","content":"old body"}',
  });
  const first = contents(
    feed(runtime, {
      index: 2,
      id: "c2",
      name: "write_file",
      args: '{"file_path":"/b.py","content":"n',
    }),
  );
  assert.deepEqual(first, [{ id: "c2", toolCallId: "c2", content: "n" }]);
  const second = contents(
    feed(runtime, {
      index: 2,
      id: "c2",
      name: "write_file",
      args: '{"file_path":"/b.py","content":"new',
    }),
  );
  assert.deepEqual(second, [{ id: "c2", toolCallId: "c2", content: "new" }]);
  const state = runtime.partialToolArgsBySlot.get("2");
  assert.equal(state?.id, "c2");
  assert.equal(state?.args, '{"file_path":"/b.py","content":"new');
});

test("a partial input forwards whichever path field the model used, once it parses", () => {
  for (const key of ["path", "file_path", "filePath"]) {
    const runtime = makeRuntime();
    const [event] = feed(runtime, {
      index: 0,
      id: `c-${key}`,
      name: "write_file",
      args: `{"${key}":"/files/a.py","content":"pri`,
    });
    assert.ok(event && event.type === "tool-input-delta");
    if (event.type === "tool-input-delta") {
      assert.deepEqual(event.input, { content: "pri", [key]: "/files/a.py" });
      assert.deepEqual(event.toolCall.input, event.input);
    }
  }
});

test("content streamed before its path still delivers the path once it parses", () => {
  // DeepSeek commonly emits `content` ahead of `file_path`: the path only
  // parses after the content is complete, so its arrival alone is a partial.
  const runtime = makeRuntime();
  const snapshots = [
    '{"content":"pri',
    '{"content":"print(1)",',
    '{"content":"print(1)","file_path":"/files/a',
    '{"content":"print(1)","file_path":"/files/a.py"}',
    '{"content":"print(1)","file_path":"/files/a.py"}',
  ];
  const inputs = snapshots.map((args) =>
    feed(runtime, { index: 0, id: "c1", name: "write_file", args }).map(
      (event) => (event.type === "tool-input-delta" ? event.input : null),
    ),
  );
  assert.deepEqual(inputs, [
    [{ content: "pri" }],
    [{ content: "print(1)" }],
    [{ content: "print(1)", file_path: "/files/a" }],
    [{ content: "print(1)", file_path: "/files/a.py" }],
    [],
  ]);
});
