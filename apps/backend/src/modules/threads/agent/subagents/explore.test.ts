import assert from "node:assert/strict";
import { test } from "vitest";
import type { StructuredTool } from "@langchain/core/tools";
import { StateBackend } from "deepagents";
import { AGENT_TOOL_NAMES } from "@sourceweft/agent-tool-registry";
import {
  EXPLORE_SUBAGENT_NAME,
  createExploreSubagent,
  exploreResponseSchema,
} from "./explore";

function fakeTool(name: string): StructuredTool {
  return { name } as unknown as StructuredTool;
}

function build(availableTools: StructuredTool[] = []) {
  return createExploreSubagent({
    availableTools,
    backend: new StateBackend({ state: { files: {} } } as never),
    middleware: [],
  });
}

test("explore is read-only: keeps search, drops mutating tools", () => {
  const sub = build([
    fakeTool(AGENT_TOOL_NAMES.searchSources),
    fakeTool("write_file"),
    fakeTool("publish_artifact"),
  ]);
  const toolNames = (sub.tools ?? []).map((tool) => tool.name);
  assert.deepEqual(toolNames, [AGENT_TOOL_NAMES.searchSources]);
});

test("explore inherits the billed model and raises no HITL", () => {
  const sub = build();
  // No model override → inherits the billed defaultModel.
  assert.equal(sub.model, undefined);
  // Explicit empty interruptOn → never inherits parent HITL.
  assert.deepEqual(sub.interruptOn, {});
});

test("explore is selectable and read-only-described", () => {
  const sub = build();
  assert.equal(sub.name, EXPLORE_SUBAGENT_NAME);
  assert.equal(sub.name, "explore");
  assert.match(sub.description, /read-only/i);
  assert.ok(sub.systemPrompt.length > 0);
});

test("explore carries no inline responseFormat (structured report is a dedicated call)", () => {
  const sub = build();
  // No inline responseFormat: the schema tool is not auto-bound each loop
  // (unreliable on DeepSeek). The structured report is produced by a dedicated
  // withStructuredOutput call after investigation, keyed on this exported schema.
  assert.equal(sub.responseFormat, undefined);
  const parsed = exploreResponseSchema.parse({
    summary: "answer",
    findings: [
      { claim: "c1", citationMarkers: ["[1]"], sourceReferences: ["s1"] },
    ],
    limitations: ["unknown x"],
  });
  assert.equal(parsed.findings[0]?.claim, "c1");
});

test("explore carries a filesystem middleware for working-file reads", () => {
  const sub = build();
  assert.ok((sub.middleware ?? []).length >= 1);
});
