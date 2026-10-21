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
import { PUBLISHED_ARTIFACT_NEXT_STEP } from "@sourceweft/contracts/agent-tools";
import { ScriptedChatModel } from "../../../../test/chat-model";
import { config } from "../../../../shared/config";
import {
  createSourceWeftAgentMiddlewareStack,
  createSourceWeftSubagentMiddlewareStack,
} from "./index";
import { readCommittedDelivery } from "./committed-delivery";
import {
  selectAgentRunProgress,
  selectAgentStepStop,
  type AgentStepV2ScopeBudget,
} from "./step-budget";

// Unit storage boundary only: the production middleware stack, the static tool
// registry (real publish_artifact / publish_video_presentation definitions) and
// the SDK protocol stay real, as in step-budget-full-stack.test.ts.
vi.mock("../../../../shared/chat-checkpointer", async () => {
  const { MemorySaver } = await import("@langchain/langgraph");
  const saver = new MemorySaver();
  return { getChatCheckpointer: async () => saver };
});

const PUBLISHER = "publish_artifact";
const VIDEO_PUBLISHER = "publish_video_presentation";
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
const call = (name: string, id: string, args: Record<string, unknown> = {}) =>
  new AIMessage({ content: "", tool_calls: [{ name, id, args }] });
const systemText = (messages: BaseMessage[]) =>
  messages
    .filter((message) => message._getType() === "system")
    .map((message) => String(message.content))
    .join("\n");
const has = (messages: BaseMessage[], marker: string) =>
  systemText(messages).includes(marker);
/** The count the finish instruction announces, tagged by phase. */
const announced = (messages: BaseMessage[]) => {
  const text = systemText(messages);
  if (!text.includes(COMMITTED_MARKER)) return null;
  const working =
    /Further tool-calling decisions before this run is moved into bounded closing: (\d+)/.exec(
      text,
    );
  if (working) return `working:${working[1]}`;
  const closing =
    /Remaining closing decisions \(including this one\): (\d+)/.exec(text);
  return closing ? `closing:${closing[1]}` : "unknown";
};

type Turn = {
  userMessageId: string;
  request: string;
  respond: (call: number, messages: BaseMessage[]) => AIMessage;
};
type Outcome = {
  seen: BaseMessage[][];
  progress: ReturnType<typeof selectAgentRunProgress>;
  stop: ReturnType<typeof selectAgentStepStop>;
  scope: AgentStepV2ScopeBudget;
};

/** One thread; each turn builds a fresh production stack like the runner. */
async function thread(input: {
  thread: string;
  /** Outputs the publisher returns, in call order across turns. */
  publishes: string[];
  turns: Turn[];
  maxSteps?: number;
  closingSteps?: number;
}) {
  const previous = {
    maxSteps: config.chat.agent.maxSteps,
    closingSteps: config.chat.agent.closingSteps,
  };
  config.chat.agent.maxSteps = input.maxSteps ?? 400;
  config.chat.agent.closingSteps = input.closingSteps ?? 40;
  const saver = new MemorySaver();
  const counts = { probes: 0, published: 0 };
  const outcomes: Outcome[] = [];
  try {
    for (const [index, turn] of input.turns.entries()) {
      const seen: BaseMessage[][] = [];
      const model = new ScriptedChatModel((messages) => {
        seen.push(messages);
        return turn.respond(seen.length, messages);
      });
      const publisher = tool(async () => input.publishes[counts.published++]!, {
        name: PUBLISHER,
        description: "publish",
        schema: z.object({}),
      });
      const probe = tool(
        async () => {
          counts.probes++;
          return "rechecked";
        },
        { name: "probe", description: "recheck", schema: z.object({}) },
      );
      const backend = new StateBackend();
      const middleware = await createSourceWeftAgentMiddlewareStack({
        backend,
        model,
        modelAlias: "chat-default",
        filesystemMounts: [],
        runId: `${input.thread}-run-${index}`,
        toolObservabilityContext: { userMessageId: turn.userMessageId },
      });
      const agent = createDeepAgent({
        model,
        tools: [publisher, probe],
        backend,
        middleware,
        checkpointer: saver,
      }) as unknown as {
        invoke(input: unknown, options?: unknown): Promise<Record<string, any>>;
      };
      const result = await agent.invoke(
        { messages: [new HumanMessage(turn.request)] },
        { configurable: { thread_id: input.thread }, recursionLimit: 300 },
      );
      outcomes.push({
        seen,
        progress: selectAgentRunProgress(result, {
          userMessageId: turn.userMessageId,
        }),
        stop: selectAgentStepStop(result, {
          userMessageId: turn.userMessageId,
        }),
        scope: result.sourceweftRunStepBudget.scopes.main,
      });
    }
    return { outcomes, ...counts };
  } finally {
    Object.assign(config.chat.agent, previous);
  }
}
const single = async (
  input: Omit<Parameters<typeof thread>[0], "turns"> & {
    respond: Turn["respond"];
  },
) => {
  const run = await thread({
    ...input,
    turns: [
      {
        userMessageId: `${input.thread}-u`,
        request: "Build and publish the report.",
        respond: input.respond,
      },
    ],
  });
  return { ...run.outcomes[0]!, probes: run.probes, published: run.published };
};

test("after a committed publish the run ends with one further model call that is told to finish", async () => {
  const outcome = await single({
    thread: "committed-normal",
    publishes: [receipt("version-1")],
    respond: (n) =>
      n === 1
        ? call(PUBLISHER, "publish-1")
        : new AIMessage("Published the report; QA passed before publishing."),
  });
  assert.equal(outcome.seen.length, 2);
  assert.equal(outcome.published, 1);
  assert.equal(announced(outcome.seen[0]!), null);
  assert.equal(announced(outcome.seen[1]!), "working:3");
  assert.equal(outcome.progress?.phase, "working");
  assert.equal(outcome.stop, null);
  assert.equal(outcome.scope.wallClock?.trigger, undefined);
});

test("a runaway loop after a committed publish is moved into closing, then closing finalizes it", async () => {
  const outcome = await single({
    thread: "committed-runaway",
    closingSteps: 5,
    publishes: [receipt("version-1")],
    respond: (n, messages) =>
      n === 1
        ? call(PUBLISHER, "publish-1")
        : has(messages, SUMMARY_MARKER)
          ? new AIMessage(
              "Delivered version-1; later rechecks were not needed.",
            )
          : call("probe", `probe-${n}`),
  });
  // publish, three ignored instructions, the last normal decision, the five
  // closing decisions, then the summary without tools.
  assert.equal(outcome.seen.length, 11);
  assert.equal(outcome.probes, 9);
  assert.deepEqual(outcome.seen.slice(1, 10).map(announced), [
    "working:3",
    "working:2",
    "working:1",
    "working:0",
    "closing:5",
    "closing:4",
    "closing:3",
    "closing:2",
    "closing:1",
  ]);
  // The finish instruction replaces the closing prompt after a delivery.
  for (const messages of outcome.seen.slice(5, 10))
    assert.equal(has(messages, CLOSING_MARKER), false);
  const summary = outcome.seen[10]!;
  assert.ok(has(summary, SUMMARY_MARKER));
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
  assert.equal(outcome.scope.wallClock?.trigger, "committed_delivery");
  assert.equal(outcome.stop?.agentRunStop.summaryStatus, "completed");
});

test("a requested second deliverable that takes more than three decisions still publishes within closing", async () => {
  const outcome = await single({
    thread: "committed-second-deliverable",
    publishes: [receipt("version-report"), receipt("version-deck")],
    respond: (n) =>
      n === 1
        ? call(PUBLISHER, "publish-report")
        : n <= 5
          ? call("probe", `build-deck-${n}`)
          : n === 6
            ? call(PUBLISHER, "publish-deck")
            : new AIMessage("Published the report and the requested deck."),
  });
  assert.equal(outcome.published, 2);
  assert.equal(outcome.seen.length, 7);
  assert.deepEqual(outcome.seen.slice(1).map(announced), [
    "working:3",
    "working:2",
    "working:1",
    "working:0",
    "closing:40",
    "closing:39",
  ]);
  assert.equal(outcome.progress?.phase, "closing");
  assert.equal(outcome.scope.wallClock?.trigger, "committed_delivery");
  assert.equal(outcome.stop, null);
});

test("a delivery committed during closing keeps normal closing accounting", async () => {
  const outcome = await single({
    thread: "committed-closing",
    maxSteps: 1,
    closingSteps: 6,
    publishes: [receipt("version-1")],
    respond: (n, messages) =>
      has(messages, SUMMARY_MARKER)
        ? new AIMessage("Delivered during closing.")
        : n === 2
          ? call(PUBLISHER, "publish-closing")
          : call("probe", `probe-${n}`),
  });
  // probe (last normal), publish (closing), five more closing decisions, summary.
  assert.equal(outcome.seen.length, 8);
  assert.ok(has(outcome.seen[1]!, CLOSING_MARKER));
  assert.deepEqual(outcome.seen.slice(2, 7).map(announced), [
    "closing:5",
    "closing:4",
    "closing:3",
    "closing:2",
    "closing:1",
  ]);
  assert.ok(has(outcome.seen[7]!, SUMMARY_MARKER));
  assert.equal(outcome.progress?.phase, "finalizing");
});

test("a draft then final revision may publish again and restarts the finish allowance", async () => {
  const outcome = await single({
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
  assert.deepEqual(outcome.seen.slice(1).map(announced), [
    "working:3",
    "working:2",
    "working:3",
    "working:2",
    "working:1",
  ]);
  assert.equal(outcome.progress?.phase, "working");
  assert.equal(outcome.stop, null);
});

test("an idempotent republish of the same version does not restart the allowance", async () => {
  const outcome = await single({
    thread: "committed-reused",
    publishes: [receipt("version-1"), receipt("version-1")],
    respond: (n) =>
      n === 5
        ? new AIMessage("Delivered version-1.")
        : n <= 2
          ? call(PUBLISHER, `publish-${n}`)
          : call("probe", `probe-${n}`),
  });
  assert.deepEqual(outcome.seen.slice(1).map(announced), [
    "working:3",
    "working:2",
    "working:1",
    "working:0",
  ]);
  assert.equal(outcome.progress?.normalSteps, outcome.progress?.normalLimit);
  assert.equal(outcome.scope.wallClock?.trigger, "committed_delivery");
});

test("a failed publish or ready-looking text is not a committed delivery", async () => {
  const outcome = await single({
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
    assert.equal(has(messages, COMMITTED_MARKER), false);
  assert.equal(outcome.progress?.phase, "working");
  assert.equal(outcome.stop, null);
});

test("an earlier turn's delivery never tells a new request on the same thread to finish", async () => {
  const run = await thread({
    thread: "committed-two-turns",
    publishes: [receipt("version-1")],
    turns: [
      {
        userMessageId: "turn-1",
        request: "Build and publish the report.",
        respond: (n) =>
          n === 1
            ? call(PUBLISHER, "publish-1")
            : new AIMessage("Published the report."),
      },
      {
        userMessageId: "turn-2",
        request: "Add a methodology section.",
        respond: (n) =>
          n <= 5
            ? call("probe", `revise-${n}`)
            : new AIMessage("Drafted the section."),
      },
    ],
  });
  const [first, second] = run.outcomes;
  assert.equal(announced(first!.seen[1]!), "working:3");
  assert.equal(second!.seen.length, 6);
  for (const messages of second!.seen)
    assert.equal(has(messages, COMMITTED_MARKER), false);
  assert.equal(run.probes, 5);
  assert.equal(second!.progress?.phase, "working");
  assert.equal(second!.progress?.normalSteps, 6);
  assert.equal(second!.scope.wallClock?.trigger, undefined);
  assert.equal(second!.stop, null);
});

test("a committed video presentation result also triggers the finish instruction", async () => {
  const previous = {
    maxSteps: config.chat.agent.maxSteps,
    closingSteps: config.chat.agent.closingSteps,
  };
  config.chat.agent.maxSteps = 400;
  config.chat.agent.closingSteps = 40;
  try {
    const seen: BaseMessage[][] = [];
    const model = new ScriptedChatModel((messages) => {
      seen.push(messages);
      return seen.length === 1
        ? call(VIDEO_PUBLISHER, "video-1")
        : new AIMessage("The video is published.");
    });
    const video = tool(
      async () =>
        JSON.stringify({
          status: "ready",
          type: "committed_artifact_result",
          artifactType: "video_presentation",
          artifactId: "video-1",
          artifactVersionId: "video-version-1",
          artifactOutputBlockId: "artifact-output:run:video-1:video-version-1",
          workflowVersion: "video-presentation-agent",
        }),
      { name: VIDEO_PUBLISHER, description: "publish", schema: z.object({}) },
    );
    const backend = new StateBackend();
    const agent = createDeepAgent({
      model,
      tools: [video],
      backend,
      middleware: await createSourceWeftAgentMiddlewareStack({
        backend,
        model,
        modelAlias: "chat-default",
        filesystemMounts: [],
        toolObservabilityContext: { userMessageId: "video-u" },
      }),
      checkpointer: new MemorySaver(),
    }) as unknown as {
      invoke(input: unknown, options?: unknown): Promise<any>;
    };
    await agent.invoke(
      { messages: [new HumanMessage("Make the video.")] },
      { configurable: { thread_id: "committed-video" } },
    );
    assert.equal(seen.length, 2);
    assert.equal(announced(seen[1]!), "working:3");
  } finally {
    Object.assign(config.chat.agent, previous);
  }
});

test("a child agent's delivery finishes the child only; the parent scope is not told to finish", async () => {
  const parentSeen: BaseMessage[][] = [];
  const childSeen: BaseMessage[][] = [];
  let probes = 0;
  const parent = new ScriptedChatModel((messages) => {
    parentSeen.push(messages);
    const n = parentSeen.length;
    return n === 1
      ? call("task", "delegate-1", {
          subagent_type: "child",
          description: "Publish the report.",
        })
      : n <= 6
        ? call("probe", `integrate-${n}`)
        : new AIMessage("Integrated the child's report.");
  });
  const child = new ScriptedChatModel((messages) => {
    childSeen.push(messages);
    return childSeen.length === 1
      ? call(PUBLISHER, "child-publish")
      : new AIMessage("Child published the report.");
  });
  const publisher = tool(async () => receipt("child-version"), {
    name: PUBLISHER,
    description: "publish",
    schema: z.object({}),
  });
  const probe = tool(
    async () => {
      probes++;
      return "integrated";
    },
    { name: "probe", description: "integrate", schema: z.object({}) },
  );
  const backend = new StateBackend();
  const agent = createDeepAgent({
    model: parent,
    tools: [probe],
    backend,
    middleware: await createSourceWeftAgentMiddlewareStack({
      backend,
      model: parent,
      modelAlias: "chat-default",
      filesystemMounts: [],
      toolObservabilityContext: { userMessageId: "child-scope-u" },
    }),
    checkpointer: new MemorySaver(),
    subagents: [
      {
        name: "child",
        description: "child",
        systemPrompt: "Publish what you are asked to.",
        model: child,
        tools: [publisher],
        middleware: createSourceWeftSubagentMiddlewareStack({
          backend,
          model: child,
          toolObservabilityContext: {
            userMessageId: "child-scope-u",
            subagentType: "child",
          },
        }),
      },
    ],
  }) as unknown as { invoke(input: unknown, options?: unknown): Promise<any> };
  const result = await agent.invoke(
    { messages: [new HumanMessage("Delegate the report, then integrate.")] },
    {
      configurable: { thread_id: "committed-child-scope" },
      recursionLimit: 200,
    },
  );
  assert.equal(childSeen.length, 2);
  assert.equal(announced(childSeen[1]!), "working:3");
  assert.equal(parentSeen.length, 7);
  for (const messages of parentSeen)
    assert.equal(has(messages, COMMITTED_MARKER), false);
  assert.equal(probes, 5);
  assert.equal(
    selectAgentRunProgress(result, { userMessageId: "child-scope-u" })?.phase,
    "working",
  );
});

test("committed delivery is read from this turn's host tool messages of a declared publisher only", () => {
  const human = new HumanMessage("Publish.");
  const ai = call(PUBLISHER, "publish-1");
  const done = (name: string, content: string, status?: "error") =>
    new ToolMessage({
      content,
      name,
      tool_call_id: "publish-1",
      ...(status ? { status } : {}),
    });
  assert.equal(
    readCommittedDelivery([human, ai, done(PUBLISHER, receipt("v1"), "error")]),
    null,
  );
  assert.equal(
    readCommittedDelivery([human, ai, done("probe", receipt("v1"))]),
    null,
  );
  assert.deepEqual(
    readCommittedDelivery([
      human,
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
  assert.equal(
    readCommittedDelivery([
      human,
      ai,
      done(PUBLISHER, receipt("v1")),
      new AIMessage("Published."),
      new HumanMessage("Add a section."),
      call("probe", "p2"),
    ]),
    null,
  );
});
