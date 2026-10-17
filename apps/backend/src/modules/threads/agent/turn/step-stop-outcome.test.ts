import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { MemorySaver } from "@langchain/langgraph";
import { createDeepAgent, StateBackend } from "deepagents";
import { z } from "zod";
import { ScriptedChatModel } from "../../../../test/chat-model";
import { ContentError } from "../../../content/errors";
import { toObservationError } from "../../stream";
import { checkpointRefFromConfig } from "./checkpoint";
import { createSourceWeftStepBudgetMiddleware } from "../middleware/step-budget";
import assert from "node:assert/strict";
import { test, vi } from "vitest";
import type { AgentRunStop } from "@sourceweft/contracts";
import { collectToolStreamEvents } from "../../../../test/turn-stream-collectors";
import {
  AgentStepSummaryError,
  agentRunStopFromStepBudgetError,
} from "../middleware/step-budget";
import {
  applyVerifiedAgentStepStop,
  assertAgentStepStopNotCancelled,
  rememberAgentStepFailureCheckpoint,
  agentCheckpointFromStepStopError,
  captureAgentStepFailureCheckpoint,
} from "./step-stop-outcome";
import { createTurnRuntime } from "./turn-runtime";
import { buildFinalOutcome } from "./final-outcome";

const stop: AgentRunStop = {
  reason: "step_limit",
  steps: 2,
  limit: 2,
  canContinue: true,
  summaryStatus: "completed",
};
function runtime() {
  return createTurnRuntime({
    prepared: {
      runTraceId: "step-stop",
      workspace: { id: "workspace" },
      thread: { id: "thread" },
    } as never,
  });
}
function outcomeInput(value: ReturnType<typeof runtime>, agent?: unknown) {
  return {
    agent: agent ?? { getState: vi.fn().mockResolvedValue(null) },
    beforeAssistantCheckpoint: null,
    beforeInputCheckpoint: null,
    finalCheckpoint: null,
    runConfig: {},
    runtime: value,
    prepared: {
      userMessage: { id: "human-current" },
      runTraceId: "step-stop",
      commandSuccessCriteria: {
        kind: "artifact",
        toolName: "publish_artifact",
        artifactType: "html",
      },
    },
  } as unknown as Parameters<typeof buildFinalOutcome>[0];
}

test("verified step summary replaces stale prose without promoting tool-only fallback", () => {
  const value = runtime();
  value.assistantContent = "Earlier draft";
  value.assistantContentFromUpdates = "Stale fallback";
  applyVerifiedAgentStepStop(value, {
    agentRunStop: stop,
    summaryText: "  Prepared the input; publishing remains unfinished.  ",
  });
  assert.equal(
    value.assistantContent,
    "Prepared the input; publishing remains unfinished.",
  );
  assert.equal(value.assistantContentFromUpdates, null);
  assert.equal(value.finishReason, "step_limit");
  assert.deepEqual(value.agentRunStop, stop);
});

test("empty or failed summary is an explicit typed failure, never successful fallback", () => {
  for (const selected of [
    { agentRunStop: stop, summaryText: " \n " },
    {
      agentRunStop: { ...stop, summaryStatus: "failed" as const },
      summaryText: "not an accepted model summary",
    },
  ]) {
    const value = runtime();
    assert.throws(
      () => applyVerifiedAgentStepStop(value, selected),
      (error: unknown) => {
        assert.ok(error instanceof AgentStepSummaryError);
        assert.deepEqual(agentRunStopFromStepBudgetError(error), {
          ...stop,
          summaryStatus: "failed",
        });
        return true;
      },
    );
    assert.equal(value.agentRunStop, undefined);
    assert.equal(value.assistantContent, "");
  }
});

test("partial summary stays visible when required publication has not happened", async () => {
  const value = runtime();
  applyVerifiedAgentStepStop(value, {
    agentRunStop: stop,
    summaryText:
      "The report is generated, but no publication receipt was obtained. Continue to verify and publish.",
  });
  const events = await collectToolStreamEvents(
    buildFinalOutcome(outcomeInput(value)),
  );
  const done = events.find((event) => event.type === "done");
  assert.equal(done?.type, "done");
  if (done?.type !== "done") throw Error("missing outcome");
  assert.equal(done.outcome.assistantContent, value.stepLimitSummary);
  assert.equal(done.outcome.finishReason, "step_limit");
  assert.deepEqual(done.outcome.agentRunStop, stop);
  assert.deepEqual(done.outcome.toolCalls, []);
  assert.ok(
    !done.outcome.renderBlocks?.some(
      (block) => block.type === "artifact_output",
    ),
  );
  assert.ok(events.some((event) => event.type === "text-delta"));
  assert.ok(!done.outcome.assistantContent.includes("Command failed"));
});

test("budget stop never fabricates completion of pending or running tool calls", async () => {
  const value = runtime();
  value.toolCallOrder.push("running");
  value.toolCallsById.set("running", {
    id: "running",
    tool: "execute",
    status: "running",
    input: {},
  } as never);
  value.pendingToolStreamsByRunId.set("pending", {
    normalizedInput: { path: "unexecuted.txt" },
    streamRunId: "pending",
    toolName: "write_file",
  });
  applyVerifiedAgentStepStop(value, {
    agentRunStop: stop,
    summaryText: "Stopped before the next operation. Work remains unfinished.",
  });
  const agent = {
    getState: vi.fn().mockResolvedValue({
      config: {
        configurable: { thread_id: "thread", checkpoint_id: "stopped" },
      },
      values: {
        messages: [
          {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "never-started",
                name: "write_file",
                args: { path: "unexecuted.txt", content: "not delivered" },
              },
            ],
          },
        ],
      },
    }),
  };
  const events = await collectToolStreamEvents(
    buildFinalOutcome(outcomeInput(value, agent)),
  );
  const done = events.find((event) => event.type === "done");
  if (done?.type !== "done") throw Error("missing outcome");
  assert.deepEqual(
    done.outcome.toolCalls.map((call) => ({
      id: call.id,
      status: call.status,
    })),
    [{ id: "running", status: "running" }],
  );
  assert.equal(value.pendingToolStreamsByRunId.size, 1);
  assert.equal(done.outcome.agentCheckpoint.final?.checkpointId, "stopped");
});

test("canonical step summary replaces earlier streamed text and retains tool cards", async () => {
  const value = runtime();
  value.hasStreamedText = true;
  value.renderBlocks.appendText("Earlier streamed draft");
  value.renderBlocks.appendTool("existing-tool");
  applyVerifiedAgentStepStop(value, {
    agentRunStop: stop,
    summaryText: "Progress saved; the remaining work needs another run.",
  });
  const events = await collectToolStreamEvents(
    buildFinalOutcome(outcomeInput(value)),
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === "text-replace" && event.text === value.stepLimitSummary,
    ),
  );
  const done = events.find((event) => event.type === "done");
  if (done?.type !== "done") throw Error("missing outcome");
  assert.ok(done.outcome.renderBlocks?.some((block) => block.type === "tool"));
  assert.ok(
    !JSON.stringify(done.outcome.renderBlocks).includes(
      "Earlier streamed draft",
    ),
  );
});

test("cancellation wins over both a late step summary and its failure", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    assertAgentStepStopNotCancelled({ abortSignal: controller.signal }),
    (error: unknown) => {
      assert.equal((error as { code: string }).code, "CLIENT_CANCELLED");
      return true;
    },
  );
  const cancelled = Object.assign(new Error("cancelled"), {
    code: "CLIENT_CANCELLED",
  });
  await assert.rejects(
    assertAgentStepStopNotCancelled({
      runCancellation: {
        throwIfCancelled: async () => {
          throw cancelled;
        },
      },
    }),
    (error) => error === cancelled,
  );
});

test("summary failure keeps its current trusted checkpoint across error wrapping", () => {
  const failure = new AgentStepSummaryError(stop);
  const checkpoint = {
    beforeInput: { threadId: "thread", checkpointId: "old-input" },
    beforeAssistant: null,
    resume: null,
    final: {
      threadId: "thread",
      checkpointId: "current-saved-progress",
      checkpointNs: "",
    },
  };
  rememberAgentStepFailureCheckpoint(failure, checkpoint);
  const wrapped = new Error("outer", { cause: failure });
  assert.deepEqual(agentCheckpointFromStepStopError(wrapped), checkpoint);
  checkpoint.final.checkpointId = "caller-mutation";
  const selected = agentCheckpointFromStepStopError(failure);
  assert.equal(selected?.final?.checkpointId, "current-saved-progress");
  if (selected?.final) selected.final.checkpointId = "consumer-mutation";
  assert.equal(
    agentCheckpointFromStepStopError(failure)?.final?.checkpointId,
    "current-saved-progress",
  );
  assert.equal(
    agentCheckpointFromStepStopError({ agentCheckpoint: checkpoint }),
    null,
  );
});

test("missing failure checkpoint stays explicit and never becomes the old input", () => {
  const failure = new AgentStepSummaryError(stop);
  rememberAgentStepFailureCheckpoint(failure, {
    beforeInput: { threadId: "thread", checkpointId: "old-input" },
    beforeAssistant: null,
    resume: null,
    final: null,
  });
  assert.equal(agentCheckpointFromStepStopError(failure)?.final, null);
  const cycle: { cause?: unknown } = {};
  cycle.cause = cycle;
  assert.equal(agentCheckpointFromStepStopError(cycle), null);
});

for (const scenario of ["summary-failure", "payment-failure"] as const) {
  test(`real SDK wrapped ${scenario} retains its typed stop and current checkpoint`, async () => {
    let effects = 0;
    let summaryAttempts = 0;
    const cause =
      scenario === "payment-failure"
        ? new ContentError(402, "CREDITS_REQUIRED", "Insufficient credits")
        : new Error("model summary failed");
    const probe = tool(
      async () => {
        effects++;
        return "input saved, not published";
      },
      {
        name: "probe",
        description: "one bounded action",
        schema: z.object({}),
      },
    );
    const model = new ScriptedChatModel((messages) => {
      if (
        messages.some(
          (message) =>
            typeof message.content === "string" &&
            message.content.includes(
              "business-step budget for this run is exhausted",
            ),
        )
      ) {
        summaryAttempts++;
        throw cause;
      }
      return new AIMessage({
        content: "",
        tool_calls: [{ id: `probe-${scenario}`, name: "probe", args: {} }],
      });
    });
    const budget = createSourceWeftStepBudgetMiddleware({
      userMessageId: "human-current",
      maxSteps: 1,
    });
    const agent = createDeepAgent({
      model,
      tools: [probe],
      backend: new StateBackend(),
      checkpointer: new MemorySaver(),
      middleware: [budget.governance, budget.finalization],
    });
    const options = { configurable: { thread_id: `outcome-${scenario}` } };
    let original: unknown;
    try {
      await agent.invoke(
        {
          messages: [
            new HumanMessage(
              "Prepare the input and publish after verification.",
            ),
          ],
        } as never,
        options,
      );
    } catch (error) {
      original = error;
    }
    assert.ok(original, "the real graph must reject its failed summary");
    assert.equal(
      summaryAttempts,
      1,
      "the fixture must actually exercise the tools-disabled summary call",
    );
    assert.equal(effects, 1, "the exhausted graph executes no extra tool");
    // The real middleware supplies its private default state; do not seed a
    // forged budget channel merely to satisfy the SDK's projected input type.
    const head = (await agent.getState(options)) as unknown as {
      config: unknown;
    };
    const checkpoint = checkpointRefFromConfig(head.config);
    assert.ok(checkpoint);
    const canonical = await captureAgentStepFailureCheckpoint({
      error: original,
      beforeInput: null,
      beforeAssistant: null,
      readCurrentCheckpoint: async () => checkpoint,
    });
    assert.ok(canonical instanceof ContentError);
    assert.equal(
      canonical.code,
      scenario === "payment-failure"
        ? "CREDITS_REQUIRED"
        : "AGENT_STEP_SUMMARY_FAILED",
    );
    assert.equal(
      canonical.statusCode,
      scenario === "payment-failure" ? 402 : 500,
    );
    const normalized = toObservationError(canonical);
    assert.equal(
      normalized,
      canonical,
      "the stream keeps the registered ContentError identity",
    );
    assert.deepEqual(agentRunStopFromStepBudgetError(normalized), {
      reason: "step_limit",
      steps: 1,
      limit: 1,
      canContinue: true,
      summaryStatus: "failed",
    });
    assert.deepEqual(
      agentCheckpointFromStepStopError(normalized)?.final,
      checkpoint,
    );
  });
}

test("step summary preserves an already committed artifact card without making another", async () => {
  const value = runtime();
  value.hasStreamedText = true;
  value.renderBlocks.appendText("Earlier text");
  const committed = {
    artifactId: "committed-artifact",
    artifactVersionId: "immutable-version",
    producer: { kind: "main" as const },
    sourceToolCallId: "publisher-receipt",
    threadRunId: "current-run",
  };
  value.renderBlocks.appendArtifactOutput(committed);
  applyVerifiedAgentStepStop(value, {
    agentRunStop: stop,
    summaryText:
      "The existing published artifact is saved. Download verification and the remaining work still need another run.",
  });
  const events = await collectToolStreamEvents(
    buildFinalOutcome(outcomeInput(value)),
  );
  const done = events.find((event) => event.type === "done");
  if (done?.type !== "done") throw Error("missing outcome");
  const cards =
    done.outcome.renderBlocks?.filter(
      (block) => block.type === "artifact_output",
    ) ?? [];
  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.artifactId, committed.artifactId);
  assert.equal(cards[0]?.artifactVersionId, committed.artifactVersionId);
  assert.equal(done.outcome.finishReason, "step_limit");
  assert.deepEqual(done.outcome.agentRunStop, stop);
});
