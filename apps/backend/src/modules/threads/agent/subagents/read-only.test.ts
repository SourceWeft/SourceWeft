import assert from "node:assert/strict";
import { test } from "vitest";
import type { StructuredTool } from "@langchain/core/tools";
import { StateBackend } from "deepagents";
import { AGENT_TOOL_NAMES } from "@sourceweft/agent-tool-registry";
import {
  READ_ONLY_BUSINESS_TOOL_NAMES,
  READ_ONLY_FILESYSTEM_PERMISSIONS,
  filterReadOnlyBusinessTools,
  readOnlyChildMiddleware,
} from "./read-only";

function fakeTool(name: string): StructuredTool {
  return { name } as unknown as StructuredTool;
}

function fakeBackend() {
  return new StateBackend({ state: { files: {} } } as never);
}

test("filterReadOnlyBusinessTools keeps only read-only business tools", () => {
  const kept = filterReadOnlyBusinessTools([
    fakeTool(AGENT_TOOL_NAMES.searchSources),
    fakeTool("write_file"),
    fakeTool("bash"),
    fakeTool("publish_artifact"),
  ]).map((tool) => tool.name);

  assert.deepEqual(kept, [AGENT_TOOL_NAMES.searchSources]);
  const keptNames: readonly string[] = kept;
  for (const forbidden of ["write_file", "bash", "publish_artifact"]) {
    assert.ok(!keptNames.includes(forbidden));
  }
});

test("READ_ONLY_BUSINESS_TOOL_NAMES references a real registry tool id", () => {
  assert.ok(READ_ONLY_BUSINESS_TOOL_NAMES.has(AGENT_TOOL_NAMES.searchSources));
});

test("filesystem policy denies all writes", () => {
  const write = READ_ONLY_FILESYSTEM_PERMISSIONS.find(
    (rule) => rule.operations.includes("write") && rule.paths.includes("/**"),
  );
  assert.equal(write?.mode, "deny");
});

test("readOnlyChildMiddleware prepends the deny-write filesystem middleware", () => {
  const extra = { name: "SomeChildMiddleware" } as never;
  const stack = readOnlyChildMiddleware({
    backend: fakeBackend(),
    middleware: [extra],
  });

  // The filesystem middleware is first; the passed child governance follows.
  assert.ok(stack.length >= 2);
  assert.equal(stack[stack.length - 1], extra);
});
