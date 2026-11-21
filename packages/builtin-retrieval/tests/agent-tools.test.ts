import assert from "node:assert/strict";
import test from "node:test";
import { createCapabilityAgentTools } from "../src/agent-tools";

const services = { retrieval: { searchSources: async () => [] } };

function bound(context?: Parameters<typeof createCapabilityAgentTools>[0]["context"]) {
  return createCapabilityAgentTools({ ...(context ? { context } : {}), services }).tools.map(
    (entry) => entry.tool.name,
  );
}

test("source search binds when the turn binds it", () => {
  assert.deepEqual(
    bound({ shouldBindAgentTool: () => true, isToolDenied: () => false }),
    ["search_sources"],
  );
});

test("source search stays unbound when the turn did not select it", () => {
  // A tool command turn binds only its workflow's tools; binding anyway is a
  // host error (CAPABILITY_TOOL_BINDING_UNEXPECTED).
  assert.deepEqual(
    bound({ shouldBindAgentTool: (name) => name !== "search_sources", isToolDenied: () => false }),
    [],
  );
});

test("a denied tool never binds", () => {
  assert.deepEqual(bound({ shouldBindAgentTool: () => true, isToolDenied: () => true }), []);
});

test("without a service there is nothing to bind", () => {
  assert.deepEqual(createCapabilityAgentTools({ services: {} }).tools, []);
});
