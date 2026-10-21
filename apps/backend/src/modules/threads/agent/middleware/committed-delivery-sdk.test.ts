import assert from "node:assert/strict";
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { MemorySaver } from "@langchain/langgraph";
import { createDeepAgent, StateBackend } from "deepagents";
import { test, vi } from "vitest";
import { z } from "zod";
import { registerAgentTools } from "@sourceweft/agent-tool-registry";
import {
  defineAgentTool,
  PUBLISHED_ARTIFACT_NEXT_STEP,
} from "@sourceweft/contracts/agent-tools";
import { ScriptedChatModel } from "../../../../test/chat-model";
import { config } from "../../../../shared/config";
import { createSourceWeftAgentMiddlewareStack } from "./index";
import {
  COMMITTED_DELIVERY_TOOL_DECISION_LIMIT,
  readCommittedDelivery,
} from "./committed-delivery";
import { selectAgentRunProgress, selectAgentStepStop } from "./step-budget";

// Unit storage boundary only: the production middleware stack and SDK protocol
// stay real, as in step-budget-full-stack.test.ts.
vi.mock("../../../../shared/chat-checkpointer", async () => {
  const { MemorySaver } = await import("@langchain/langgraph");
  const saver = new MemorySaver();
  return { getChatCheckpointer: async () => saver };
});

const PUBLISHER = "test_publish_receipt";
registerAgentTools([
  defineAgentTool({
    id: "testPublishReceipt",
    name: PUBLISHER,
    domain: "artifact",
    capabilities: ["artifact"],
    activation: {
      default: "off",
      userControl: "none",
      skill: { declarable: false, activates: false },
    },
    terminalResult: { kind: "published_artifact", artifactTypes: ["html"] },
  }),
]);

const COMMITTED_MARKER = "Deliverable committed, finish now";
const CLOSING_MARKER = "You have entered bounded delivery closing";
const SUMMARY_MARKER = "business-step budget for this run is exhausted";

const receipt = (version: string) =>
  JSON.stringify({
    ok: true,
    type: "html_artifact_result",
    status: "ready",
    nextStep: PUBLISHED_ARTIFACT_NEXT_STEP,
    reused: false,
    artifactType: "html",
    artifactId: "artifact-1",
    artifact_id: "artifact-1",
    artifactVersionId: version,
    artifactUrl: "/artifact-preview?artifactId=artifact-1",
  });
const failure = JSON.stringify({
  ok: false,
  type: "html_artifact_error",
  status: "failed",
  code: "ARTIFACT_SOURCE_INVALID",
  message: "source.path is required",
  recoverable: true,
});
const call = (name: string, id: string) =>
  new AIMessage({ content: "", tool_calls: [{ name, id, args: {} }] });
const systemText = (messages: BaseMessage[]) =>
  messages
    .filter((message) => message._getType() === "system")
    .map((message) => String(message.content))
    .join("\n");
const remaining = (messages: BaseMessage[]) => {
  const match =
    /Tool-calling decisions left before this run is closed: (\d+)/.exec(
      systemText(messages),
    );
  return match ? Number(match[1]) : null;
};

async function run(input: {
  thread: string;
  /** Outputs the publisher returns, in call order. */
  publishes: string[];
  respond: (call: number, messages: BaseMessage[]) => AIMessage;
  maxSteps?: number;
  closingSteps?: number;
}) {
  const previous = {
    maxSteps: config.chat.agent.maxSteps,
    closingSteps: config.chat.agent.closingSteps,
  };
  config.chat.agent.maxSteps = input.maxSteps ?? 400;
  config.chat.agent.closingSteps = input.closingSteps ?? 40;
  const seen: BaseMessage[][] = [];
  let probes = 0,
    published = 0;
  try {
    const model = new ScriptedChatModel((messages) => {
      seen.push(messages);
      return input.respond(seen.length, messages);
    });
    const publisher = tool(async () => input.publishes[published++]!, {
      name: PUBLISHER,
      description: "publish",
      schema: z.object({}),
    });
    const probe = tool(
      async () => {
        probes++;
        return "rechecked";
      },
      { name: "probe", description: "recheck", schema: z.object({}) },
    );
    const backend = new StateBackend();
    const userMessageId = `${input.thread}-u`;
    const middleware = await createSourceWeftAgentMiddlewareStack({
      backend,
      model,
      modelAlias: "chat-default",
      filesystemMounts: [],
      toolObservabilityContext: { userMessageId },
    });
    const agent = createDeepAgent({
      model,
      tools: [publisher, probe],
      backend,
      middleware,
      checkpointer: new MemorySaver(),
    }) as unknown as {
      invoke(input: unknown, options?: unknown): Promise<Record<string, any>>;
    };
    const result = await agent.invoke(
      { messages: [new HumanMessage("Build and publish the report.")] },
      { configurable: { thread_id: input.thread }, recursionLimit: 200 },
    );
    return {
      result,
      seen,
      probes,
      published,
      progress: selectAgentRunProgress(result, { userMessageId }),
      stop: selectAgentStepStop(result, { userMessageId }),
    };
  } finally {
    Object.assign(config.chat.agent, previous);
  }
}

test("after a committed publish the run ends with one further model call that is told to finish", async () => {
  const outcome = await run({
    thread: "committed-normal",
    publishes: [receipt("version-1")],
    respond: (n) =>
      n === 1
        ? call(PUBLISHER, "publish-1")
        : new AIMessage("Published the report; QA passed before publishing."),
  });
  assert.equal(outcome.seen.length, 2);
  assert.equal(outcome.published, 1);
  assert.equal(systemText(outcome.seen[0]!).includes(COMMITTED_MARKER), false);
  assert.ok(systemText(outcome.seen[1]!).includes(COMMITTED_MARKER));
  assert.equal(
    remaining(outcome.seen[1]!),
    COMMITTED_DELIVERY_TOOL_DECISION_LIMIT,
  );
  assert.equal(outcome.progress?.phase, "working");
  assert.equal(outcome.stop, null);
});

test("three tool-calling decisions after a committed publish force the finalizing summary without tools", async () => {
  const outcome = await run({
    thread: "committed-forced",
    publishes: [receipt("version-1")],
    respond: (n, messages) =>
      n === 1
        ? call(PUBLISHER, "publish-1")
        : systemText(messages).includes(SUMMARY_MARKER)
          ? new AIMessage(
              "Delivered version-1; later rechecks were not needed.",
            )
          : call("probe", `probe-${n}`),
  });
  // publish, three ignored finish instructions, then the summary call.
  assert.equal(outcome.seen.length, 5);
  assert.equal(outcome.probes, 3);
  assert.deepEqual(outcome.seen.slice(1, 4).map(remaining), [3, 2, 1]);
  const summary = outcome.seen[4]!;
  assert.ok(systemText(summary).includes(SUMMARY_MARKER));
  // The summary sees only bounded records, including the committed receipt.
  const records = JSON.parse(
    String(summary.find((message) => message._getType() === "human")?.content),
  ).progressRecords as Array<Record<string, unknown>>;
  assert.deepEqual(
    records.find((record) => record.tool === PUBLISHER)?.committedArtifact,
    {
      artifactType: "html",
      artifactId: "artifact-1",
      artifactVersionId: "version-1",
    },
  );
  assert.equal(outcome.progress?.phase, "finalizing");
  assert.equal(outcome.stop?.agentRunStop.summaryStatus, "completed");
  assert.equal(
    outcome.stop?.summaryText,
    "Delivered version-1; later rechecks were not needed.",
  );
});

test("a delivery committed during closing replaces the closing prompt and still finalizes after three decisions", async () => {
  const outcome = await run({
    thread: "committed-closing",
    maxSteps: 1,
    closingSteps: 10,
    publishes: [receipt("version-1")],
    respond: (n, messages) =>
      systemText(messages).includes(SUMMARY_MARKER)
        ? new AIMessage("Delivered during closing.")
        : n === 2
          ? call(PUBLISHER, "publish-closing")
          : call("probe", `probe-${n}`),
  });
  // probe (last normal), publish (closing), three probes, summary.
  assert.equal(outcome.seen.length, 6);
  assert.ok(systemText(outcome.seen[1]!).includes(CLOSING_MARKER));
  for (const messages of outcome.seen.slice(2, 5)) {
    assert.ok(systemText(messages).includes(COMMITTED_MARKER));
    assert.equal(systemText(messages).includes(CLOSING_MARKER), false);
  }
  assert.ok(systemText(outcome.seen[5]!).includes(SUMMARY_MARKER));
  assert.deepEqual(outcome.stop?.agentRunStop, {
    policyVersion: 2,
    reason: "step_limit",
    normalSteps: 1,
    normalLimit: 1,
    closingSteps: 10,
    closingLimit: 10,
    steps: 11,
    limit: 11,
    canContinue: true,
    summaryStatus: "completed",
  });
});

test("a draft then final revision may publish again and restarts the finish allowance", async () => {
  const outcome = await run({
    thread: "committed-revision",
    publishes: [receipt("version-draft"), receipt("version-final")],
    respond: (n) =>
      n === 1
        ? call(PUBLISHER, "publish-draft")
        : n === 3
          ? call(PUBLISHER, "publish-final")
          : n === 6
            ? new AIMessage("Published the final revision.")
            : call("probe", `probe-${n}`),
  });
  assert.equal(outcome.published, 2);
  assert.equal(outcome.seen.length, 6);
  // Remaining after draft: 3, 2; the final revision restarts it: 3, 2, 1.
  assert.deepEqual(outcome.seen.slice(1).map(remaining), [3, 2, 3, 2, 1]);
  assert.equal(outcome.progress?.phase, "working");
  assert.equal(outcome.stop, null);
});

test("an idempotent republish of the same version does not restart the allowance", async () => {
  const outcome = await run({
    thread: "committed-reused",
    publishes: [receipt("version-1"), receipt("version-1")],
    respond: (n, messages) =>
      systemText(messages).includes(SUMMARY_MARKER)
        ? new AIMessage("Delivered version-1.")
        : n <= 2
          ? call(PUBLISHER, `publish-${n}`)
          : call("probe", `probe-${n}`),
  });
  assert.deepEqual(outcome.seen.slice(1, 4).map(remaining), [3, 2, 1]);
  assert.equal(outcome.seen.length, 5);
  assert.equal(outcome.progress?.phase, "finalizing");
});

test("a failed publish or ready-looking text is not a committed delivery", async () => {
  const outcome = await run({
    thread: "committed-failure",
    publishes: [failure, "status: ready"],
    respond: (n) =>
      n <= 2
        ? call(PUBLISHER, `publish-${n}`)
        : n <= 6
          ? call("probe", `probe-${n}`)
          : new AIMessage("Publishing failed; nothing was delivered."),
  });
  assert.equal(outcome.seen.length, 7);
  for (const messages of outcome.seen)
    assert.equal(systemText(messages).includes(COMMITTED_MARKER), false);
  assert.equal(outcome.progress?.phase, "working");
  assert.equal(outcome.stop, null);
});

test("committed delivery is read from host tool messages of the declared publisher only", () => {
  const ai = call(PUBLISHER, "publish-1");
  const done = (name: string, content: string, status?: "error") =>
    new ToolMessage({
      content,
      name,
      tool_call_id: "publish-1",
      ...(status ? { status } : {}),
    });
  assert.equal(
    readCommittedDelivery([ai, done(PUBLISHER, receipt("v1"), "error")]),
    null,
  );
  assert.equal(readCommittedDelivery([ai, done("probe", receipt("v1"))]), null);
  assert.deepEqual(
    readCommittedDelivery([
      ai,
      done(PUBLISHER, receipt("v1")),
      call("probe", "p1"),
      new AIMessage("text only"),
    ]),
    {
      result: {
        artifactType: "html",
        artifactId: "artifact-1",
        artifactVersionId: "v1",
      },
      toolDecisionsSince: 1,
    },
  );
});
