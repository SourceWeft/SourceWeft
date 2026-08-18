import assert from "node:assert/strict";
import { test } from "vitest";
import type { ToolCallTrace } from "../..";
import {
  isSubagentNamespace,
  namespaceSegments,
  recordToolCallNamespace,
  resolveToolProducer,
} from "./subagent-namespace";

function trace(partial: Partial<ToolCallTrace> & { id: string }): ToolCallTrace {
  return {
    tool: "task",
    input: {},
    output: null,
    status: "running",
    latencyMs: null,
    error: null,
    sequence: 0,
    ...partial,
  };
}

test("depth < 2 is the main agent (incl. its own depth-1 task tool namespace)", () => {
  // Verified real shapes (subagent-namespace.e2e.test.ts): a main-agent tool
  // event — the `task` call included — is depth 1 and must classify as main.
  assert.equal(isSubagentNamespace(undefined), false);
  assert.equal(isSubagentNamespace([]), false);
  assert.equal(isSubagentNamespace(["tools:branch-1"]), false);
  assert.equal(isSubagentNamespace(["model_request:x"]), false);
});

test("depth >= 2 is a sub-agent", () => {
  assert.equal(isSubagentNamespace(["tools:branch-1", "tools:branch-2"]), true);
  assert.equal(
    isSubagentNamespace(["tools:a", "tools:b", "tools:c"]),
    true,
  );
});

test("namespaceSegments ignores non-string / empty entries", () => {
  assert.deepEqual(namespaceSegments(["tools:a", "", 42, null, "tools:b"]), [
    "tools:a",
    "tools:b",
  ]);
  assert.deepEqual(namespaceSegments("tools:a"), []);
});

test("resolveToolProducer correlates a child to its parent task by prefix", () => {
  const toolCallsById = new Map<string, ToolCallTrace>([
    ["task-1", trace({ id: "task-1", input: { subagent_type: "explore" } })],
  ]);
  const taskCallIdByNamespaceKey = new Map<string, string>();
  // The parent `task` tool event (depth 1) streamed first and was recorded.
  recordToolCallNamespace(
    ["tools:branch-1"],
    "task-1",
    taskCallIdByNamespaceKey,
  );

  // The child echo event (depth 2) shares the parent's namespace as its prefix.
  assert.deepEqual(
    resolveToolProducer(["tools:branch-1", "tools:branch-2"], {
      toolCallsById,
      taskCallIdByNamespaceKey,
    }),
    { kind: "subagent", taskCallId: "task-1", subagentType: "explore" },
  );
});

test("resolveToolProducer groups by namespace prefix when the task is unknown", () => {
  // Parent not yet recorded: still group (by the stable prefix), just unnamed.
  assert.deepEqual(
    resolveToolProducer(["tools:branch-1", "tools:branch-2"], {
      toolCallsById: new Map(),
      taskCallIdByNamespaceKey: new Map(),
    }),
    { kind: "subagent", taskCallId: "tools:branch-1" },
  );
});

test("resolveToolProducer returns undefined for the main agent", () => {
  assert.equal(
    resolveToolProducer(["tools:branch-1"], {
      toolCallsById: new Map(),
      taskCallIdByNamespaceKey: new Map(),
    }),
    undefined,
  );
});
