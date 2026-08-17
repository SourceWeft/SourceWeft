import assert from "node:assert/strict";
import { test } from "vitest";
import type { StructuredTool } from "@langchain/core/tools";
import { createGeneralPurposeSubagent } from "./general-purpose";

function fakeTool(name: string): StructuredTool {
  return { name } as unknown as StructuredTool;
}

test("explicit general-purpose child inherits tools, skills, HITL, and child governance", () => {
  const interruptOn = { execute: true };
  const middleware = [{ name: "ChildGovernance" }];
  const subagent = createGeneralPurposeSubagent({
    availableTools: [fakeTool("search_sources"), fakeTool("publish_artifact")],
    interruptOn,
    middleware,
    skills: ["/skills/"],
  });

  assert.equal(subagent.name, "general-purpose");
  assert.deepEqual(
    subagent.tools?.map((tool) => tool.name),
    ["search_sources", "publish_artifact"],
  );
  assert.strictEqual(subagent.interruptOn, interruptOn);
  assert.strictEqual(subagent.middleware, middleware);
  assert.deepEqual(subagent.skills, ["/skills/"]);
  assert.equal(subagent.model, undefined);
});
