import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { StateBackend } from "deepagents";
import { config } from "../../../shared/config";
import { createInterpreterMiddlewareForTurn } from "./interpreter";

const originalEnabled = config.chat.agent.interpreter.enabled;

afterEach(() => {
  config.chat.agent.interpreter.enabled = originalEnabled;
});

function createMiddleware() {
  return createInterpreterMiddlewareForTurn({
    allowedTools: [],
    backend: new StateBackend({ state: { files: {} } } as never),
    context: {
      teamId: "team-1",
      workspaceId: "workspace-1",
      threadId: "thread-1",
      turnId: "turn-1",
      userId: "user-1",
    },
  });
}

test("backend interpreter feature gate is off by default", () => {
  config.chat.agent.interpreter.enabled = false;
  assert.deepEqual(createMiddleware(), []);
});

test("backend interpreter feature gate installs official eval plus SourceWeft guard", () => {
  config.chat.agent.interpreter.enabled = true;
  const middleware = createMiddleware() as unknown as Array<{
    name: string;
    tools?: Array<{ name: string }>;
  }>;

  assert.deepEqual(
    middleware.map((item) => item.name),
    ["CodeInterpreterMiddleware", "SourceWeftInterpreterGuard"],
  );
  assert.deepEqual(
    middleware[0]?.tools?.map((item) => item.name),
    ["eval"],
  );
});
