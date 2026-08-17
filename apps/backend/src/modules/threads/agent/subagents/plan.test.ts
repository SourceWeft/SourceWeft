import assert from "node:assert/strict";
import { test } from "vitest";
import type { StructuredTool } from "@langchain/core/tools";
import { StateBackend } from "deepagents";
import { AGENT_TOOL_NAMES } from "@sourceweft/agent-tool-registry";
import {
  PLAN_SUBAGENT_NAME,
  createPlanSubagent,
  planResponseSchema,
} from "./plan";

function fakeTool(name: string): StructuredTool {
  return { name } as unknown as StructuredTool;
}

function build(availableTools: StructuredTool[] = []) {
  return createPlanSubagent({
    availableTools,
    backend: new StateBackend({ state: { files: {} } } as never),
    middleware: [],
  });
}

test("plan shares explore's read-only scope: keeps search, drops mutating tools", () => {
  const sub = build([
    fakeTool(AGENT_TOOL_NAMES.searchSources),
    fakeTool("edit_file"),
    fakeTool("execute"),
  ]);
  const toolNames = (sub.tools ?? []).map((tool) => tool.name);
  assert.deepEqual(toolNames, [AGENT_TOOL_NAMES.searchSources]);
});

test("plan inherits the billed model and raises no HITL", () => {
  const sub = build();
  assert.equal(sub.model, undefined);
  assert.deepEqual(sub.interruptOn, {});
});

test("plan is selectable and describes itself as read-only planning", () => {
  const sub = build();
  assert.equal(sub.name, PLAN_SUBAGENT_NAME);
  assert.equal(sub.name, "plan");
  assert.match(sub.description, /plan/i);
  assert.match(sub.description, /cannot write|read-only/i);
  assert.ok(sub.systemPrompt.length > 0);
});

test("plan carries no inline responseFormat but exports a plan schema (steps, risks, open questions)", () => {
  const sub = build();
  // No inline responseFormat: the schema tool is not auto-bound each loop
  // (unreliable on DeepSeek). The structured plan is produced by a dedicated
  // withStructuredOutput call after investigation, keyed on this exported schema.
  assert.equal(sub.responseFormat, undefined);
  const parsed = planResponseSchema.parse({
    summary: "objective",
    steps: [{ title: "s1", detail: "d1", keyReferences: ["ref"] }],
    risks: ["r1"],
    openQuestions: ["q1"],
  });
  assert.equal(parsed.steps[0]?.title, "s1");
});
