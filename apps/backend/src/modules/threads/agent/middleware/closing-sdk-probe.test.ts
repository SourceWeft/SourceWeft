import assert from "node:assert/strict";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { createDeepAgent, StateBackend } from "deepagents";
import { createMiddleware } from "langchain";
import { test } from "vitest";
import { ScriptedChatModel } from "../../../../test/chat-model";

test("installed SDK task identity, child exposure, runtime state and native output probe", async () => {
  const advertised: string[][] = [];
  let parentCalls = 0;
  let observed: any;
  const childTools: string[][] = [];
  const child = new ScriptedChatModel(() => new AIMessage("child result"));
  child.bindTools = ((tools: any[]) => {
    childTools.push(tools.map((t) => t.name));
    return child;
  }) as any;
  const model = new ScriptedChatModel(() =>
    ++parentCalls === 1
      ? new AIMessage({
          content: "",
          tool_calls: [
            {
              id: "probe-task",
              name: "task",
              args: { description: "probe", subagent_type: "probe-child" },
            },
          ],
        })
      : new AIMessage("done"),
  );
  model.bindTools = ((tools: any[]) => {
    advertised.push(tools.map((t) => t.name));
    return model;
  }) as any;
  const probe = createMiddleware({
    name: "Probe",
    wrapToolCall: async (request, handler) => {
      const result = await handler(request);
      observed = {
        name: request.toolCall.name,
        id: request.toolCall.id,
        stateMessages: request.state.messages.length,
        runtime: !!request.runtime.signal,
        result,
      };
      return result;
    },
  });
  const result: any = await createDeepAgent({
    model,
    backend: new StateBackend(),
    middleware: [probe],
    subagents: [
      {
        name: "probe-child",
        description: "probe",
        model: child,
        systemPrompt: "probe",
        tools: [],
      },
    ],
  }).invoke({ messages: [new HumanMessage("probe")] });
  assert(advertised[0]!.includes("task"));
  assert.equal(observed.name, "task");
  assert.equal(observed.id, "probe-task");
  assert(observed.stateMessages > 0);
  assert(observed.result.update);
  assert.equal(observed.result.update.messages[0].tool_call_id, "probe-task");
  assert.equal(observed.result.update.messages[0].content, "child result");
  assert(childTools.every((names) => !names.includes("task")));
  assert.equal(result.messages.at(-1).content, "done");
});
