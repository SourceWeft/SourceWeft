import assert from "node:assert/strict";
import { test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createDeepAgent: vi.fn(() => ({
    invoke: vi.fn(),
    stream: vi.fn(),
  })),
}));

vi.mock("deepagents", () => ({
  createDeepAgent: mocks.createDeepAgent,
}));

import { createDeepAgentsRuntimeHandoff } from "./deepagents-runtime";

test("createDeepAgentsRuntimeHandoff delegates execution to deepagents with LangChain tools", () => {
  mocks.createDeepAgent.mockClear();
  const tool = {
    name: "mcp__github__create_issue",
    description: "Create a GitHub issue",
    invoke: vi.fn(),
  };

  const handoff = createDeepAgentsRuntimeHandoff({
    model: "test-model",
    tools: [tool],
    systemPrompt: "Use the selected tool when needed.",
    interruptOn: {
      mcp__github__create_issue: {
        allowedDecisions: ["approve", "edit", "reject"],
      },
    },
  });

  const results = mocks.createDeepAgent.mock.results as Array<{ value: unknown }>;
  assert.equal(handoff.runtime, results[0]?.value);
  assert.deepEqual(handoff.tools, [tool]);
  assert.equal(handoff.boundary, "deepagents");
  assert.equal(mocks.createDeepAgent.mock.calls.length, 1);
  const calls = mocks.createDeepAgent.mock.calls as unknown as Array<[unknown]>;
  assert.deepEqual(calls[0]?.[0], {
    model: "test-model",
    tools: [tool],
    systemPrompt: "Use the selected tool when needed.",
    interruptOn: {
      mcp__github__create_issue: {
        allowedDecisions: ["approve", "edit", "reject"],
      },
    },
  });
});

test("createDeepAgentsRuntimeHandoff requires an explicit LangChain tool array", () => {
  mocks.createDeepAgent.mockClear();

  assert.throws(
    () =>
      createDeepAgentsRuntimeHandoff({
        model: "test-model",
        tools: null as never,
      }),
    /DeepAgents handoff requires a LangChain tool array/,
  );
  assert.equal(mocks.createDeepAgent.mock.calls.length, 0);
});
