import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { expandToolCallOutputsFromClient } from "@sourceweft/contracts";
import { createIsolatedTestDatabase } from "../../../test/isolated-database";
import { createPreparedThreadTurn } from "../../../test/prepared-turn";
import { createBillingPort } from "../../../test/thread-stream-fixtures";
import type { AgentCitation, DeepAgentTurnEvent } from "../agent";
import type { MessageRecord } from "../../content/types";
import type {
  MessageRenderBlock,
  MeteredLlmCallTrace,
  ModelReasoningSegmentTrace,
  PreparedThreadTurn,
  ThinkingStepTrace,
  ToolCallTrace,
} from "../turn/types";
import type { ChatRunSnapshot, ChatThreadRunRecord } from "./types";

/**
 * Issue #333 size bounds, measured on the real write paths.
 *
 * The first test replays a synthetic long report run shaped like the measured
 * run 7fdc6102 through the real durable runner (`processThreadChatRunJob`) and
 * the real stream service; only the agent runtime is scripted, so every
 * snapshot write, the finalizer, the message projection and the terminal
 * commit are production code against PostgreSQL. The second test writes a
 * pre-#333 snapshot row directly and shows the next progress write shrinks it.
 *
 * Synthetic text comes from a seeded word generator, not repeated filler, so
 * PostgreSQL compression (`pg_column_size`) is not flattered by runs of
 * identical bytes.
 */

const mocked = vi.hoisted(() => ({ stream: vi.fn() }));
vi.mock("../stream/service", () => ({
  ContentThreadStreamService: class {
    streamThreadEvents(...args: unknown[]) {
      return mocked.stream(...args);
    }
  },
}));

let isolated:
  Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
let schema: typeof import("@sourceweft/db");
let repository: typeof import("./repository");
let runner: typeof import("./runner");
let streams: typeof import("./stream-manager");
let snapshotModule: typeof import("./snapshot");
let messages: typeof import("../message-repository");
let clientView: typeof import("../message-client-view");
const originalDatabaseUrl = process.env.DATABASE_URL;
let teamId: string;
let workspaceId: string;
let threadId: string;
const userId = "report-user";

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("snapshot_size");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
  repository = await import("./repository");
  runner = await import("./runner");
  streams = await import("./stream-manager");
  snapshotModule = await import("./snapshot");
  messages = await import("../message-repository");
  clientView = await import("../message-client-view");
}, 120_000);

beforeEach(async () => {
  [teamId, workspaceId, threadId] = [randomUUID(), randomUUID(), randomUUID()];
  await schema.db.insert(schema.workspaces).values({
    id: workspaceId,
    organizationId: teamId,
    name: "Snapshot size bounds",
    slug: `snapshot-size-bounds-${workspaceId}`,
  });
  await schema.db.insert(schema.threads).values({
    id: threadId,
    teamId,
    workspaceId,
    title: "Quarterly market report",
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  mocked.stream.mockReset();
  if (schema)
    await schema.db
      .delete(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId));
});

afterAll(async () => {
  if (schema) await schema.database.end();
  if (isolated) await isolated.close();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

// ---------------------------------------------------------------------------
// Synthetic run shape (measured run 7fdc6102, Issue #333 design §1)
// ---------------------------------------------------------------------------

/** Model steps that call tools; one more step writes the final report. */
const TOOL_STEP_COUNT = 39;
const STEP_COUNT = TOOL_STEP_COUNT + 1;
/** Steps whose model call streamed no reasoning (38 of 40 have a segment). */
const STEPS_WITHOUT_REASONING = new Set([13, 27]);
const TOOL_CALL_COUNT = 84;
const WRITE_FILE_CALLS = new Set([60, 82]);
const EXECUTE_CALLS = new Map([
  [20, 1_200],
  [33, 2_400],
  [45, 6_144],
  [52, 900],
  [70, 3_600],
  [78, 6_000],
]);
const WEB_FETCH_CALLS = new Set([5, 11]);
const THINKING_STEP_COUNT = 75; // two events each → 150 thinking-step events
const AVAILABLE_CITATION_COUNT = 177;
const USED_CITATION_COUNT = 3;
const METERED_CALL_COUNT = 43;
const EXCERPT_CHARS = 320;
/** Reasoning streams token-sized: the measured run averaged ~3.7 chars/delta. */
const REASONING_DELTA_CHARS = 5;
const TEXT_DELTA_CHARS = 40;
const REPORT_CHARS = 12_000;
const WRITE_FILE_CONTENT_CHARS = 15 * 1_024;

const SNAPSHOT_COMPRESSED_LIMIT = 400 * 1_024;

/** Assistant-message metadata scalars a slim snapshot copy may keep (§2.1). */
const SLIM_ASSISTANT_METADATA_KEYS = new Set([
  "finishReason",
  "errorCode",
  "error",
  "isError",
  "isCancelled",
  "threadRun",
  "traceId",
  "userMessageId",
  "agentRunStop",
]);
const SLIM_ASSISTANT_MESSAGE_KEYS = new Set([
  "id",
  "threadId",
  "role",
  "parentMessageId",
  "content",
  "contentJson",
  "model",
  "createdAt",
  "updatedAt",
  "metadata",
]);

function createRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const WORDS = (
  "revenue margin quarter region growth churn cohort segment pricing demand " +
  "supply forecast variance baseline outlier median retention expansion " +
  "contract renewal pipeline backlog capacity utilization headcount payroll " +
  "inventory logistics freight tariff exposure hedge currency inflation rate " +
  "yield spread liquidity covenant leverage equity dividend buyback guidance " +
  "consensus estimate revision upgrade downgrade momentum volatility index " +
  "benchmark portfolio allocation weighting rebalance drawdown recovery trend " +
  "seasonal cyclical structural secular adoption penetration share competitor " +
  "entrant incumbent moat switching cost network effect platform channel " +
  "partner reseller distributor wholesale retail online offline subscription " +
  "license usage metered tier bundle discount promotion campaign conversion " +
  "funnel acquisition activation engagement satisfaction survey sentiment " +
  "therefore however although because whereas meanwhile notably overall " +
  "the a of to in for on with by from at as is was were be been this that " +
  "which while across between during against within without under over"
).split(" ");

function prose(random: () => number, chars: number, lineChars = 0): string {
  const parts: string[] = [];
  let length = 0;
  let lineLength = 0;
  while (length < chars) {
    const roll = random();
    const word =
      roll < 0.08
        ? String(Math.floor(random() * 100_000) / 100)
        : WORDS[Math.floor(random() * WORDS.length)]!;
    const separator =
      lineChars > 0 && lineLength + word.length > lineChars ? "\n" : " ";
    if (separator === "\n") lineLength = 0;
    parts.push(length === 0 ? word : `${separator}${word}`);
    length += word.length + (length === 0 ? 0 : 1);
    lineLength += word.length + 1;
  }
  return parts.join("").slice(0, chars);
}

function numberedFile(random: () => number, chars: number) {
  const lines = prose(random, chars, 88).split("\n");
  return lines
    .map((line, index) => `${String(index + 1).padStart(6)}\t${line}`)
    .join("\n")
    .slice(0, chars);
}

function chunk(text: string, size: number) {
  const pieces: string[] = [];
  for (let index = 0; index < text.length; index += size) {
    pieces.push(text.slice(index, index + size));
  }
  return pieces;
}

function bytes(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

type PlannedToolCall = {
  call: ToolCallTrace;
  step: number;
  /** Citations this call adds to the registry (read_file / web_fetch). */
  citations: AgentCitation[];
  /** write_file only: partial arguments streamed before the call starts. */
  inputDeltas: Record<string, unknown>[];
};

type SyntheticRun = {
  segmentsByStep: Map<number, ModelReasoningSegmentTrace>;
  toolCalls: PlannedToolCall[];
  thinkingSteps: ThinkingStepTrace[];
  thinkingStepsByStep: Map<number, ThinkingStepTrace[]>;
  availableCitations: AgentCitation[];
  usedCitations: AgentCitation[];
  meteredLlmCalls: MeteredLlmCallTrace[];
  renderBlocks: MessageRenderBlock[];
  reasoning: string;
  report: string;
};

function buildMeteredCall(input: {
  index: number;
  random: () => number;
  userMessageId: string;
  gatewayConfigId: string;
}): MeteredLlmCallTrace {
  const { index, random } = input;
  const inputTokens = 18_000 + Math.floor(random() * 60_000);
  const outputTokens = 300 + Math.floor(random() * 4_000);
  const reasoningTokens = Math.floor(outputTokens * 0.6);
  const cacheReadTokens = Math.floor(inputTokens * 0.8);
  const generationId = `gen-${randomUUID()}`;
  const providerRequestId = `req_${randomUUID().replaceAll("-", "")}`;
  const usage = {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    cacheReadTokens,
    reasoningTokens,
  };
  const providerCostUsd =
    Math.round(
      (inputTokens * 0.27 + outputTokens * 1.1 - cacheReadTokens * 0.2) / 10,
    ) / 100_000;
  return {
    id: `llm-call:${input.userMessageId}:${generationId}`,
    operation: "chat.stream",
    modelKind: "chat",
    modelAlias: "deepseek-v4-pro",
    profileAlias: "default-chat-thinking",
    gatewayConfigId: input.gatewayConfigId,
    usage,
    observation: {
      traceId: input.userMessageId,
      spanId: `llm-${index + 1}-${randomUUID()}`,
      identity: {
        modelAlias: "deepseek-v4-pro",
        provider: "openrouter",
        requestedProviderModel: "deepseek/deepseek-v4-pro",
        resolvedProviderModel: "deepseek/deepseek-v4-pro-20260901",
        providerRequestId,
        providerRequestIds: [providerRequestId],
        routerName: "openrouter",
      },
      usage,
      cost: {
        currency: "USD",
        inlineUsd: providerCostUsd,
        effectiveUsd: providerCostUsd,
        source: "provider_inline",
        status: "inline",
      },
      provenance: {
        usage: "provider_response.usage",
        resolvedModel: "provider_response.model",
        inlineCost: "provider_response.usage.cost",
      },
      diagnostics: [],
      providerResponseHeaders: {
        "x-request-id": providerRequestId,
        "x-ratelimit-remaining-requests": String(4_000 - index),
        "x-ratelimit-remaining-tokens": String(2_000_000 - inputTokens),
        "openrouter-processing-ms": String(800 + Math.floor(random() * 9_000)),
      },
    },
    billingStatus: "metered",
    consumedCredits: 2 + Math.floor(random() * 6),
    billedBy: "provider_cost",
    skipReason: null,
    idempotencyKey: `llm-call:${input.userMessageId}:assistant:${index + 1}`,
    referenceId: `thread:${threadId}:message:${input.userMessageId}:llm-call:${index + 1}`,
    providerCostUsd,
    costSource: "provider_actual",
    missingPriceComponents: [],
    pricingSnapshot: {
      source: "provider_inline",
      currency: "USD",
      capturedAt: new Date(1_790_000_000_000 + index * 37_000).toISOString(),
      gatewayConfigId: input.gatewayConfigId,
      modelAlias: "deepseek-v4-pro",
      providerModel: "deepseek/deepseek-v4-pro",
      unitPrices: {
        inputPerMillionTokensUsd: 0.27,
        outputPerMillionTokensUsd: 1.1,
        cacheReadPerMillionTokensUsd: 0.07,
        cacheWritePerMillionTokensUsd: 0,
        reasoningPerMillionTokensUsd: 1.1,
      },
      components: [
        { name: "input", tokens: inputTokens - cacheReadTokens, usd: 0 },
        { name: "cache_read", tokens: cacheReadTokens, usd: 0 },
        { name: "output", tokens: outputTokens, usd: 0 },
      ],
      markup: { kind: "credit_rate", creditsPerUsd: 1_000, minimumCredits: 1 },
    },
    billing: {
      teamId,
      availableCredits: 90_000 - index * 7,
      consumedThisCycle: 1_200 + index * 7,
      idempotencyReplayed: false,
    },
    metadata: {
      threadId,
      messageId: input.userMessageId,
      traceId: input.userMessageId,
      generationId,
      spanId: `llm-${index + 1}`,
      agentRunThreadId: threadId,
      step: index + 1,
      provider: "openrouter",
      requestedModel: "deepseek/deepseek-v4-pro",
      thinking: { mode: "on", effort: "high", budgetTokens: 16_000 },
      routeDecision: {
        strategy: "priority",
        selected: "openrouter/deepseek-v4-pro",
        candidates: [
          { target: "openrouter/deepseek-v4-pro", eligible: true, rank: 1 },
          { target: "deepseek/deepseek-v4-pro", eligible: false, rank: 2 },
          { target: "orcarouter/deepseek-v4-pro", eligible: false, rank: 3 },
        ],
        reason: "highest_priority_ready_target",
      },
    },
  } satisfies MeteredLlmCallTrace;
}

function buildSyntheticRun(input: {
  userMessageId: string;
  seed: number;
}): SyntheticRun {
  const random = createRandom(input.seed);
  const gatewayConfigId = `gateway-${randomUUID()}`;
  let sequence = 0;
  const nextSequence = () => ++sequence;

  const segmentsByStep = new Map<number, ModelReasoningSegmentTrace>();
  const toolCalls: PlannedToolCall[] = [];
  const thinkingStepsByStep = new Map<number, ThinkingStepTrace[]>();
  const thinkingSteps: ThinkingStepTrace[] = [];
  const availableCitations: AgentCitation[] = [];
  const renderBlocks: MessageRenderBlock[] = [];
  let reasoning = "";
  let segmentNumber = 0;
  let readFileNumber = 0;
  let toolIndex = 0;

  const toolStepOf = (index: number) =>
    Math.floor((index * TOOL_STEP_COUNT) / TOOL_CALL_COUNT);
  const thinkingStepOf = (index: number) =>
    Math.floor((index * TOOL_STEP_COUNT) / THINKING_STEP_COUNT);

  const sourceCitation = (path: string, title: string): AgentCitation => {
    const excerpt = prose(random, EXCERPT_CHARS);
    return {
      citation: `c${availableCitations.length + 1}`,
      sourceId: randomUUID(),
      sourceTitle: title,
      documentId: randomUUID(),
      chunkId: randomUUID(),
      chunkNo: Math.floor(random() * 40),
      score: Math.round(random() * 1_000) / 1_000,
      excerpt,
      quoteText: excerpt,
      origin: "read_file",
      path,
    };
  };
  const webCitation = (url: string, title: string): AgentCitation => {
    const excerpt = prose(random, EXCERPT_CHARS);
    return {
      citation: `c${availableCitations.length + 1}`,
      sourceId: null,
      sourceTitle: title,
      documentId: null,
      chunkId: `web:${randomUUID()}`,
      score: Math.round(random() * 1_000) / 1_000,
      excerpt,
      quoteText: excerpt,
      origin: "web_fetch",
      externalUri: url,
    };
  };

  for (let step = 0; step < STEP_COUNT; step++) {
    if (!STEPS_WITHOUT_REASONING.has(step)) {
      segmentNumber += 1;
      const previous = toolCalls.at(-1)?.call;
      const length = 1_000 + ((segmentNumber * 733) % 1_500);
      const text = prose(random, length);
      reasoning += text;
      const segment: ModelReasoningSegmentTrace = {
        id: `model-reasoning-${segmentNumber}`,
        text,
        sequence: nextSequence(),
        durationMs: 1_500 + length * 3,
        ...(step === 0 || !previous
          ? { phase: "initial" as const }
          : {
              phase: "after_tool" as const,
              toolCallId: previous.id,
              tool: previous.tool,
            }),
      };
      segmentsByStep.set(step, segment);
      renderBlocks.push({
        id: `reasoning-${segment.id}`,
        type: "reasoning",
        text,
        durationMs: segment.durationMs,
      });
    }

    const stepThinking: ThinkingStepTrace[] = [];
    for (let index = 0; index < THINKING_STEP_COUNT; index++) {
      if (step < TOOL_STEP_COUNT && thinkingStepOf(index) === step) {
        const thinking: ThinkingStepTrace = {
          id: `thinking-step-${index + 1}`,
          kind: "log",
          title: `Reviewing ${prose(random, 36)}`,
          status: "completed",
          items: [prose(random, 64), prose(random, 64), prose(random, 48)],
          sequence: nextSequence(),
          description: prose(random, 90),
        };
        stepThinking.push(thinking);
        thinkingSteps.push(thinking);
      }
    }
    thinkingStepsByStep.set(step, stepThinking);

    while (toolIndex < TOOL_CALL_COUNT && toolStepOf(toolIndex) === step) {
      const id = `call_${String(toolIndex).padStart(2, "0")}_${randomUUID().slice(0, 12)}`;
      const latencyMs = 40 + Math.floor(random() * 2_000);
      let call: ToolCallTrace;
      const citations: AgentCitation[] = [];
      const inputDeltas: Record<string, unknown>[] = [];
      if (WRITE_FILE_CALLS.has(toolIndex)) {
        const filePath = `/workspace/report/draft-${toolIndex}.md`;
        const content = prose(random, WRITE_FILE_CONTENT_CHARS, 100);
        for (const fraction of [0.2, 0.45, 0.7, 0.95]) {
          inputDeltas.push({
            file_path: filePath,
            content: content.slice(0, Math.floor(content.length * fraction)),
          });
        }
        call = {
          id,
          tool: "write_file",
          input: { file_path: filePath, content },
          output: `Updated file ${filePath}`,
          status: "completed",
          latencyMs,
          error: null,
          sequence: nextSequence(),
        };
      } else if (EXECUTE_CALLS.has(toolIndex)) {
        call = {
          id,
          tool: "execute",
          input: {
            command: `python3 /workspace/scripts/aggregate.py --input /workspace/data/part-${toolIndex}.csv --format table`,
          },
          output: {
            output: prose(random, EXECUTE_CALLS.get(toolIndex)!, 96),
            exitCode: 0,
            truncated: false,
          },
          status: "completed",
          latencyMs,
          error: null,
          sequence: nextSequence(),
        };
      } else if (WEB_FETCH_CALLS.has(toolIndex)) {
        const url = `https://research.example.org/briefs/${toolIndex}/${randomUUID()}`;
        const title = `Industry brief ${toolIndex}: ${prose(random, 40)}`;
        call = {
          id,
          tool: "web_fetch",
          input: { url, prompt: prose(random, 120) },
          output: { url, title, content: prose(random, 3_000, 110) },
          status: "completed",
          latencyMs,
          error: null,
          sequence: nextSequence(),
        };
        for (let index = 0; index < 3; index++) {
          const citation = webCitation(url, title);
          availableCitations.push(citation);
          citations.push(citation);
        }
      } else {
        const slug = `market-${readFileNumber}-${prose(random, 18).replaceAll(/[^a-z0-9]+/g, "-")}`;
        const filePath = `/workspace/sources/${slug}.md`;
        const size =
          readFileNumber % 18 === 17
            ? 11 * 1_024
            : 2_048 + ((readFileNumber * 397) % 1_536);
        call = {
          id,
          tool: "read_file",
          input: { file_path: filePath, offset: 0, limit: 2_000 },
          output: numberedFile(random, size),
          status: "completed",
          latencyMs,
          error: null,
          sequence: nextSequence(),
        };
        const citationCount = readFileNumber < 23 ? 3 : 2;
        for (let index = 0; index < citationCount; index++) {
          const citation = sourceCitation(
            filePath,
            `Quarterly market review ${readFileNumber}.pdf`,
          );
          availableCitations.push(citation);
          citations.push(citation);
        }
        readFileNumber += 1;
      }
      toolCalls.push({ call, step, citations, inputDeltas });
      renderBlocks.push({
        id: `tool-${call.id}`,
        type: "tool",
        toolCallId: call.id,
      });
      toolIndex += 1;
    }
  }

  const report = prose(random, REPORT_CHARS, 110);
  renderBlocks.push({
    id: `text-${renderBlocks.length + 1}`,
    type: "text",
    text: report,
  });

  const meteredLlmCalls = Array.from(
    { length: METERED_CALL_COUNT },
    (_, index) =>
      buildMeteredCall({
        index,
        random,
        userMessageId: input.userMessageId,
        gatewayConfigId,
      }),
  );

  assert.equal(segmentsByStep.size, 38);
  assert.equal(toolCalls.length, TOOL_CALL_COUNT);
  assert.equal(availableCitations.length, AVAILABLE_CITATION_COUNT);
  assert.equal(thinkingSteps.length, THINKING_STEP_COUNT);
  const usedCitations = availableCitations.filter(
    (citation) => citation.origin === "web_fetch",
  );
  assert.equal(usedCitations.length >= USED_CITATION_COUNT, true);

  return {
    segmentsByStep,
    toolCalls,
    thinkingSteps,
    thinkingStepsByStep,
    availableCitations,
    usedCitations: usedCitations.slice(0, USED_CITATION_COUNT),
    meteredLlmCalls,
    renderBlocks,
    reasoning,
    report,
  };
}

/** The agent runtime's event stream for the synthetic run. */
async function* scriptedAgentTurn(
  run: SyntheticRun,
  counts: Record<string, number>,
): AsyncGenerator<DeepAgentTurnEvent> {
  const count = (type: string) => {
    counts[type] = (counts[type] ?? 0) + 1;
  };
  const registry: AgentCitation[] = [];
  for (let step = 0; step < STEP_COUNT; step++) {
    const segment = run.segmentsByStep.get(step);
    if (segment) {
      let streamed = "";
      const deltas = chunk(segment.text, REASONING_DELTA_CHARS);
      for (const [index, delta] of deltas.entries()) {
        streamed += delta;
        const last = index === deltas.length - 1;
        count("reasoning");
        yield {
          type: "reasoning",
          reasoning: delta,
          segment: {
            ...segment,
            text: streamed,
            durationMs: last
              ? segment.durationMs
              : Math.floor(((segment.durationMs ?? 0) * index) / deltas.length),
          },
        };
      }
    }
    const thinking = run.thinkingStepsByStep.get(step) ?? [];
    for (const item of thinking) {
      count("thinking-step");
      yield {
        type: "thinking-step",
        step: { ...item, status: "in_progress", items: item.items.slice(0, 1) },
      };
    }
    for (const planned of run.toolCalls.filter((item) => item.step === step)) {
      const { call } = planned;
      const running: ToolCallTrace = {
        ...call,
        output: null,
        status: "running",
        latencyMs: null,
      };
      for (const partial of planned.inputDeltas) {
        count("tool-input-delta");
        yield {
          type: "tool-input-delta",
          id: call.id,
          tool: call.tool,
          input: partial,
          toolCall: { ...running, input: partial },
        };
      }
      count("tool-call-start");
      yield {
        type: "tool-call-start",
        id: call.id,
        tool: call.tool,
        input: call.input,
        toolCall: running,
      };
      count("tool-call-result");
      yield {
        type: "tool-call-result",
        id: call.id,
        tool: call.tool,
        input: call.input,
        output: call.output,
        latencyMs: call.latencyMs,
        toolCall: call,
      };
      count("tool-call-end");
      yield {
        type: "tool-call-end",
        id: call.id,
        tool: call.tool,
        latencyMs: call.latencyMs,
        status: "completed",
        toolCall: call,
      };
      if (planned.citations.length > 0) {
        registry.push(...planned.citations);
        // Mid-run `citations` events carry the whole registry as `citations`.
        count("citations");
        yield { type: "citations", citations: [...registry] };
      }
    }
    for (const item of thinking) {
      count("thinking-step");
      yield { type: "thinking-step", step: item };
    }
  }
  for (const delta of chunk(run.report, TEXT_DELTA_CHARS)) {
    count("text-delta");
    yield { type: "text-delta", delta };
  }
  // As final-outcome.ts does, the answer's used citations close the stream.
  count("citations");
  yield {
    type: "citations",
    citations: run.usedCitations,
    availableCitations: run.availableCitations,
  };
  const usage = run.meteredLlmCalls.reduce(
    (sum, call) => ({
      inputTokens: sum.inputTokens + (call.usage?.inputTokens ?? 0),
      outputTokens: sum.outputTokens + (call.usage?.outputTokens ?? 0),
      totalTokens: sum.totalTokens + (call.usage?.totalTokens ?? 0),
    }),
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  );
  yield {
    type: "done",
    outcome: {
      assistantContent: run.report,
      retrieval: null,
      citations: run.usedCitations,
      availableCitations: run.availableCitations,
      retrievalCalls: [],
      toolCalls: run.toolCalls.map((item) => item.call),
      meteredLlmCalls: run.meteredLlmCalls,
      thinkingSteps: run.thinkingSteps,
      renderBlocks: run.renderBlocks,
      reasoningSegments: [...run.segmentsByStep.values()],
      usage,
      finishReason: "stop",
      reasoning: run.reasoning,
      agentCheckpoint: {
        beforeInput: null,
        beforeAssistant: null,
        resume: null,
        final: null,
      },
    },
  };
}

async function createRun() {
  const run = await repository.createChatThreadRun({
    teamId,
    workspaceId,
    threadId,
    userId,
    idempotencyKey: `snapshot-size:${randomUUID()}`,
    mode: "send",
    requestJson: {
      mode: "send",
      workspaceId,
      threadId,
      userId,
      content: "Write the quarterly market report from the sources.",
    },
  });
  assert.ok(run);
  return run;
}

function preparedTurn(input: {
  run: ChatThreadRunRecord;
  userMessage: MessageRecord;
}): PreparedThreadTurn {
  return createPreparedThreadTurn({
    userId,
    workspace: { id: workspaceId, organizationId: teamId },
    thread: {
      id: threadId,
      teamId,
      workspaceId,
      title: "Quarterly market report",
      modelSettings: {
        llmProfileAlias: null,
        imageProfileAlias: null,
        visionProfileAlias: null,
        llmModelAlias: null,
        imageModelAlias: null,
        visionModelAlias: null,
      },
      chatPreferences: {
        thinking: { mode: "on", effort: "high" },
        webAccess: true,
        composerOptions: {},
      },
      sourceCount: 0,
      visibility: "private",
      parentThreadId: null,
      personaId: null,
      origin: "user",
      createdBy: userId,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      lastMessageAt: null,
    },
    messageContent: input.userMessage.content,
    messageContentJson: {
      version: 1,
      parts: [{ type: "text", text: input.userMessage.content }],
    },
    agentMessageContent: input.userMessage.content,
    userMessage: input.userMessage,
    runTraceId: input.run.id,
    reasoningRun: { runId: input.run.id, parentRunId: null, base: "" },
    assistantMessageIdOverride: null,
    modelAlias: "deepseek-v4-pro",
    profileAlias: "default-chat-thinking",
    providerModel: "deepseek/deepseek-v4-pro",
    chatProfile: { gatewayConfigId: "gateway-report", configJson: {} },
    llmIdempotencyKey: `thread-stream:${input.userMessage.id}:assistant`,
    agentRunThreadId: threadId,
    initialTitle: "Quarterly market report",
    isFirstAssistantResponse: false,
  });
}

async function readSnapshotSizes(runId: string) {
  const {
    rows: [row],
  } = await schema.database.query<{
    compressed: number;
    text_bytes: number;
  }>(
    "select pg_column_size(snapshot_json)::int as compressed, octet_length(snapshot_json::text)::int as text_bytes from chat_thread_runs where id = $1",
    [runId],
  );
  assert.ok(row);
  const { rows: keys } = await schema.database.query<{
    key: string;
    text_bytes: number;
  }>(
    "select key, octet_length(value::text)::int as text_bytes from chat_thread_runs, jsonb_each(snapshot_json) where id = $1 order by 2 desc",
    [runId],
  );
  return {
    compressed: Number(row.compressed),
    textBytes: Number(row.text_bytes),
    keys: Object.fromEntries(
      keys.map((key) => [key.key, Number(key.text_bytes)]),
    ),
  };
}

async function readClientAssistantMessage(messageId: string) {
  // The /messages path: the page query with full include, then the client view.
  const page = await messages.listMessageRecordPageByThread({
    include: { citations: true, contentJson: true, metadata: true },
    teamId,
    workspaceId,
    threadId,
    limit: 50,
  });
  const stored = page.items.find((item) => item.id === messageId);
  assert.ok(stored, "assistant message missing from the /messages page");
  return {
    stored,
    view: clientView.projectThreadMessageForClient(stored),
  };
}

function metadataBreakdown(metadata: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(metadata)
      .map(([key, value]) => [key, bytes(value)] as const)
      .sort((left, right) => right[1] - left[1]),
  );
}

function asRecords(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value), "expected an array");
  return value as Record<string, unknown>[];
}

function assertSlimAssistantMessage(message: unknown) {
  const record = message as Record<string, unknown> | undefined;
  assert.ok(record, "snapshot has no assistantMessage");
  for (const key of Object.keys(record)) {
    assert.ok(
      SLIM_ASSISTANT_MESSAGE_KEYS.has(key),
      `slim assistantMessage carries ${key}`,
    );
  }
  const metadata = record.metadata as Record<string, unknown>;
  for (const key of Object.keys(metadata)) {
    assert.ok(
      SLIM_ASSISTANT_METADATA_KEYS.has(key),
      `slim assistantMessage.metadata carries ${key}`,
    );
  }
}

function assertStructureOnlyTrace(input: {
  traceParts: unknown;
  reasoningSegments: unknown;
  label: string;
}) {
  for (const part of asRecords(input.traceParts)) {
    assert.equal(
      "input" in part,
      false,
      `${input.label} part ${part.id} input`,
    );
    assert.equal(
      "output" in part,
      false,
      `${input.label} part ${part.id} output`,
    );
    if (part.kind === "reasoning")
      assert.equal(
        "text" in part,
        false,
        `${input.label} part ${part.id} text`,
      );
  }
  for (const segment of asRecords(input.reasoningSegments ?? [])) {
    assert.equal(
      "text" in segment,
      false,
      `${input.label} segment ${segment.id} text`,
    );
  }
}

function assertClientViewHasNoCopies(metadata: Record<string, unknown>) {
  for (const key of ["meteredLlmCalls", "reasoning", "traceEvents"]) {
    assert.equal(key in metadata, false, `client view carries ${key}`);
  }
  const retrieval = metadata.retrieval as Record<string, unknown>;
  for (const item of [
    ...asRecords(retrieval.citations),
    ...asRecords(retrieval.availableCitations),
  ]) {
    assert.equal("quoteText" in item, false, `${item.citation} quoteText`);
  }
  assertStructureOnlyTrace({
    traceParts: metadata.traceParts,
    reasoningSegments: metadata.reasoningSegments,
    label: "client view",
  });
}

function assertCitationRenderFields(items: Record<string, unknown>[]) {
  for (const item of items) {
    assert.equal(typeof item.citation, "string");
    assert.equal(typeof item.excerpt, "string");
    assert.equal((item.excerpt as string).length, EXCERPT_CHARS);
    assert.equal(typeof item.sourceTitle, "string");
    assert.equal(typeof item.chunkId, "string");
    if (item.origin === "read_file") {
      assert.equal(typeof item.sourceId, "string");
      assert.equal(typeof item.documentId, "string");
      assert.equal(typeof item.path, "string");
    } else {
      assert.equal(typeof item.externalUri, "string");
    }
  }
}

/**
 * Per-item structure in the client view beyond the payload the test counts
 * from the synthetic inputs (tool inputs/outputs, reasoning text, citations
 * without `quoteText`, thinking steps, the report twice: `content` and its
 * text block): ids, kinds, order/sequence, statuses, timestamps and JSON
 * punctuation. Measured on this fixture: 299 B per trace part (all 197 are
 * structure only), 133 B per tool call, 84 B per render block, 135 B per
 * reasoning segment, ~2.3 KB of message fields and metadata scalars. The
 * allowances are those plus ~15%, about 15 KB of headroom on a ~644 KB view:
 * smaller than any copy #333 removed (`quoteText` ~57 KB, part `input` ~39
 * KB, `reasoning` ~68 KB, segment text ~68 KB, `meteredLlmCalls` ~143 KB,
 * `traceEvents` ~166 KB), so reintroducing one fails the bound.
 */
const STRUCTURE_BYTES = {
  tracePart: 345,
  toolCall: 155,
  renderBlock: 97,
  reasoningSegment: 155,
  fixed: 4 * 1_024,
};

test("a long Thinking report run persists a bounded snapshot and /messages body", async () => {
  const run = await createRun();
  const counts: Record<string, number> = {};
  let appended = 0;
  vi.spyOn(streams.chatRunStreamManager, "subscribeCancel").mockResolvedValue(
    async () => {},
  );
  vi.spyOn(streams.chatRunStreamManager, "appendEvent").mockImplementation(
    async () => ++appended,
  );

  const { ContentThreadStreamService } =
    await vi.importActual<typeof import("../stream/service")>(
      "../stream/service",
    );
  const { ContentThreadTurnService } = await import("../turn/service");
  const billing = createBillingPort();
  const turnService = new ContentThreadTurnService(billing);
  let synthetic: SyntheticRun | undefined;
  const streamService = new ContentThreadStreamService(
    {
      prepareThreadTurn: async () => {
        const userMessage = await messages.createMessageRecord({
          teamId,
          workspaceId,
          threadId,
          role: "user",
          content: "Write the quarterly market report from the sources.",
          createdBy: null,
        });
        synthetic = buildSyntheticRun({
          userMessageId: userMessage.id,
          seed: 7_102,
        });
        return preparedTurn({ run, userMessage });
      },
      // The real finalizer: message projection, citations, gateway audit.
      finalizeThreadTurn: (
        command: Parameters<typeof turnService.finalizeThreadTurn>[0],
      ) => turnService.finalizeThreadTurn(command),
    } as unknown as ConstructorParameters<typeof ContentThreadStreamService>[0],
    () => scriptedAgentTurn(synthetic!, counts),
    async () => null,
    undefined,
    billing,
  );
  mocked.stream.mockImplementation(
    (...args: Parameters<typeof streamService.streamThreadEvents>) =>
      streamService.streamThreadEvents(...args),
  );

  const startedAt = Date.now();
  const result = await runner.processThreadChatRunJob({
    runId: run.id,
    teamId,
    workspaceId,
    threadId,
    userId,
  });
  const elapsedMs = Date.now() - startedAt;
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.ok(synthetic);
  assert.ok(result.assistantMessageId);
  assert.equal(counts["tool-call-start"], TOOL_CALL_COUNT);
  assert.equal(counts["thinking-step"], THINKING_STEP_COUNT * 2);

  // 1. The persisted snapshot is bounded and carries one copy of each state.
  const sizes = await readSnapshotSizes(run.id);
  const persisted = (await repository.findChatThreadRunById({
    runId: run.id,
    teamId,
    workspaceId,
  }))!;
  assert.equal(persisted.status, "completed");
  const snapshot = persisted.snapshotJson as ChatRunSnapshot;
  assert.ok(
    sizes.compressed < SNAPSHOT_COMPRESSED_LIMIT,
    `pg_column_size(snapshot_json) is ${sizes.compressed} bytes`,
  );
  assertSlimAssistantMessage(snapshot.assistantMessage);
  assert.equal(snapshot.assistantMessage?.metadata.finishReason, "stop");
  for (const key of ["citations", "availableCitations", "meteredLlmCalls"]) {
    assert.equal(key in snapshot, false, `snapshot carries top-level ${key}`);
  }
  assert.equal(snapshot.retrieval?.availableCitations.length, 177);
  assert.equal(snapshot.retrieval?.citations.length, USED_CITATION_COUNT);
  assertStructureOnlyTrace({
    traceParts: snapshot.traceParts,
    reasoningSegments: snapshot.reasoningSegments,
    label: "snapshot",
  });
  assert.equal(
    snapshot.meteredLlmCreditsConsumed,
    synthetic.meteredLlmCalls.reduce(
      (sum, call) => sum + call.consumedCredits,
      0,
    ),
  );

  // 2. The /messages client view drops every copy no client reads.
  const { stored, view } = await readClientAssistantMessage(
    result.assistantMessageId,
  );
  assert.equal(
    asRecords(stored.metadata.meteredLlmCalls).length,
    METERED_CALL_COUNT,
    "the messages row keeps the metering list (design D1)",
  );
  // New rows store trace structure only (design D.1/D.3), not just the view.
  assertStructureOnlyTrace({
    traceParts: stored.metadata.traceParts,
    reasoningSegments: stored.metadata.reasoningSegments,
    label: "messages row",
  });
  assertClientViewHasNoCopies(view.metadata);
  const viewBytes = bytes(view);
  const storedBytes = bytes(stored);

  // The bound: the bytes the reload must render (each once), plus a measured
  // per-item allowance for the structure around them. Payload is counted from
  // the synthetic inputs, not from the response.
  const toolPayloadBytes = synthetic.toolCalls.reduce(
    (sum, { call }) => sum + bytes(call.input) + bytes(call.output),
    0,
  );
  const reasoningTextBytes = [...synthetic.segmentsByStep.values()].reduce(
    (sum, segment) => sum + bytes(segment.text),
    0,
  );
  const withoutQuote = (citation: AgentCitation) => {
    const { quoteText: _quoteText, ...rest } = citation;
    return rest;
  };
  const citationBytes =
    bytes(synthetic.availableCitations.map(withoutQuote)) +
    bytes(synthetic.usedCitations.map(withoutQuote));
  const thinkingStepBytes = bytes(synthetic.thinkingSteps);
  // The report is rendered from its text block; `content` is the second copy.
  const contentBytes = 2 * bytes(synthetic.report);
  const payloadBytes =
    toolPayloadBytes +
    reasoningTextBytes +
    citationBytes +
    thinkingStepBytes +
    contentBytes;
  const viewMetadata = view.metadata;
  const tracePartCount = asRecords(viewMetadata.traceParts).length;
  const renderBlockCount = asRecords(viewMetadata.renderBlocks).length;
  const structureAllowance =
    tracePartCount * STRUCTURE_BYTES.tracePart +
    TOOL_CALL_COUNT * STRUCTURE_BYTES.toolCall +
    renderBlockCount * STRUCTURE_BYTES.renderBlock +
    synthetic.segmentsByStep.size * STRUCTURE_BYTES.reasoningSegment +
    STRUCTURE_BYTES.fixed;
  const viewBound = payloadBytes + structureAllowance;

  console.log(
    "[#333 size bounds] long report run",
    JSON.stringify(
      {
        elapsedMs,
        appendedEvents: appended,
        streamedEvents: counts,
        snapshot: {
          pgColumnSize: sizes.compressed,
          textBytes: sizes.textBytes,
          compressionRatio:
            Math.round((sizes.compressed / sizes.textBytes) * 1_000) / 1_000,
          keys: sizes.keys,
        },
        messagesRow: {
          storedJsonBytes: storedBytes,
          metadata: metadataBreakdown(stored.metadata),
        },
        clientView: {
          bytes: viewBytes,
          bound: viewBound,
          payloadBytes,
          payload: {
            toolPayloadBytes,
            reasoningTextBytes,
            citationBytes,
            thinkingStepBytes,
            contentBytes,
          },
          structureBytes: viewBytes - payloadBytes,
          structureAllowance,
          tracePartCount,
          renderBlockCount,
          metadata: metadataBreakdown(viewMetadata),
        },
      },
      null,
      2,
    ),
  );
  assert.ok(
    viewBytes < viewBound,
    `/messages assistant view is ${viewBytes} bytes, bound ${viewBound}`,
  );

  // 3. Reload rendering inputs are what was streamed and what is stored.
  assert.deepEqual(viewMetadata.renderBlocks, stored.metadata.renderBlocks);
  const reasoningBlocks = asRecords(viewMetadata.renderBlocks).filter(
    (block) => block.type === "reasoning",
  );
  assert.equal(reasoningBlocks.length, 38);
  for (const block of reasoningBlocks) {
    assert.equal(typeof block.text, "string", `${block.id} text`);
    assert.ok((block.text as string).length > 0, `${block.id} text`);
    assert.equal(typeof block.durationMs, "number", `${block.id} durationMs`);
  }
  // Every segment is under the per-segment cap, so the text is exact.
  assert.equal(
    reasoningBlocks.map((block) => block.text).join(""),
    synthetic.reasoning,
  );
  const viewToolCalls = asRecords(viewMetadata.toolCalls);
  assert.equal(viewToolCalls.length, TOOL_CALL_COUNT);
  for (const { call } of synthetic.toolCalls) {
    const rendered = viewToolCalls.find((item) => item.id === call.id);
    assert.ok(rendered, `${call.id} missing from toolCalls`);
    assert.deepEqual(rendered.input, call.input, `${call.id} input`);
    assert.deepEqual(rendered.output, call.output, `${call.id} output`);
    assert.equal(rendered.status, "completed");
  }
  const retrieval = viewMetadata.retrieval as Record<string, unknown>;
  assert.equal(asRecords(retrieval.availableCitations).length, 177);
  assert.equal(asRecords(retrieval.citations).length, USED_CITATION_COUNT);
  assertCitationRenderFields(asRecords(retrieval.availableCitations));
  assertCitationRenderFields(asRecords(retrieval.citations));
  assert.equal(
    asRecords(viewMetadata.thinkingSteps).length,
    THINKING_STEP_COUNT,
  );
  assert.equal(view.content, synthetic.report);
}, 600_000);

test("an old snapshot row shrinks on its next progress write and keeps its committed state", async () => {
  const run = await createRun();
  const running = await repository.markChatThreadRunRunning({
    runId: run.id,
    teamId,
    workspaceId,
  });
  assert.equal(running?.status, "running");
  const userMessage = await messages.createMessageRecord({
    teamId,
    workspaceId,
    threadId,
    role: "user",
    content: "Write the quarterly market report from the sources.",
    createdBy: null,
  });
  const synthetic = buildSyntheticRun({
    userMessageId: userMessage.id,
    seed: 333,
  });
  const now = new Date().toISOString();
  const toolCalls = synthetic.toolCalls.map((item) => item.call);
  const segments = [...synthetic.segmentsByStep.values()];
  // Pre-#333 trace parts: tool parts carried input, reasoning parts text.
  const legacyTraceParts = [
    ...segments.map((segment) => ({
      id: segment.id,
      kind: "reasoning",
      order: segment.sequence,
      createdAt: now,
      updatedAt: now,
      text: segment.text,
      phase: segment.phase,
      ...(segment.toolCallId
        ? { toolCallId: segment.toolCallId, tool: segment.tool }
        : {}),
      durationMs: segment.durationMs,
    })),
    ...toolCalls.map((call) => ({
      id: call.id,
      kind: "tool",
      order: call.sequence,
      createdAt: now,
      updatedAt: now,
      toolCallId: call.id,
      tool: call.tool,
      status: call.status,
      input: call.input,
      latencyMs: call.latencyMs,
    })),
  ];
  // A committed artifact recorded only in the legacy embedded metadata: the
  // merge must still treat that copy as authoritative.
  const artifactId = randomUUID();
  const artifactVersionId = randomUUID();
  const artifactCall = {
    id: "call_publish_report",
    tool: "publish_document",
    input: { title: "Quarterly market report" },
    output: {
      status: "ready",
      type: "committed_artifact_result",
      artifactType: "document",
      artifactId,
      artifactVersionId,
      artifactOutputBlockId: `artifact-${artifactVersionId}`,
      workflowVersion: "1",
    },
    status: "completed",
    latencyMs: 900,
    error: null,
    sequence: 10_000,
  };
  const artifactBlock = {
    id: `artifact-${artifactVersionId}`,
    type: "artifact_output",
    artifactId,
    artifactVersionId,
    placement: "terminal",
    producer: { kind: "main" },
    sequence: 10_001,
    sourceToolCallId: artifactCall.id,
    threadRunId: run.id,
  };
  const retrieval = {
    embeddingProfileId: null,
    vectorStrategy: null,
    annIndexUsed: null,
    citations: synthetic.usedCitations,
    availableCitations: synthetic.availableCitations,
  };
  const rowMetadata: Record<string, unknown> = {
    userMessageId: userMessage.id,
    sourceUserMessageId: userMessage.id,
    traceId: run.id,
    threadRun: { id: run.id, status: "running", mode: "send" },
    modelAlias: "deepseek-v4-pro",
    finishReason: "stop",
    toolCalls,
    thinkingSteps: synthetic.thinkingSteps,
    reasoning: synthetic.reasoning,
    reasoningSegments: segments,
    traceParts: legacyTraceParts,
    renderBlocks: synthetic.renderBlocks,
    meteredLlmCalls: synthetic.meteredLlmCalls,
    meteredLlmCreditsConsumed: 120,
    retrieval,
  };
  const assistantMessage = await messages.createMessageRecord({
    teamId,
    workspaceId,
    threadId,
    parentMessageId: userMessage.id,
    role: "assistant",
    content: synthetic.report,
    createdBy: null,
    model: "deepseek-v4-pro",
    metadata: rowMetadata,
  });
  const oldSnapshot: Record<string, unknown> = {
    reasoningRun: { runId: run.id, parentRunId: null, base: "" },
    reasoningRevision: 9_000,
    assistantContent: synthetic.report,
    reasoning: synthetic.reasoning,
    reasoningSegments: segments,
    toolCalls,
    thinkingSteps: synthetic.thinkingSteps,
    traceParts: legacyTraceParts,
    renderBlocks: synthetic.renderBlocks,
    citations: synthetic.usedCitations,
    availableCitations: synthetic.availableCitations,
    meteredLlmCalls: synthetic.meteredLlmCalls,
    meteredLlmCreditsConsumed: 120,
    lastEventType: "assistant-message",
    assistantMessage: {
      ...assistantMessage,
      metadata: {
        ...rowMetadata,
        toolCalls: [...toolCalls, artifactCall],
        renderBlocks: [...synthetic.renderBlocks, artifactBlock],
      },
    },
  };
  await schema.database.query(
    "update chat_thread_runs set snapshot_json = $1::jsonb, user_message_id = $2, assistant_message_id = $3 where id = $4",
    [JSON.stringify(oldSnapshot), userMessage.id, assistantMessage.id, run.id],
  );
  const before = await readSnapshotSizes(run.id);

  await repository.updateChatThreadRunProgress({
    runId: run.id,
    teamId,
    workspaceId,
    eventOffset: 1,
    snapshotJson: { lastEventType: "thinking-step" },
    returnRecord: false,
  });

  const after = await readSnapshotSizes(run.id);
  const persisted = (await repository.findChatThreadRunById({
    runId: run.id,
    teamId,
    workspaceId,
  }))!;
  const snapshot = persisted.snapshotJson as ChatRunSnapshot;
  console.log(
    "[#333 size bounds] old row",
    JSON.stringify(
      {
        before: {
          pgColumnSize: before.compressed,
          textBytes: before.textBytes,
          keys: before.keys,
        },
        after: {
          pgColumnSize: after.compressed,
          textBytes: after.textBytes,
          keys: after.keys,
        },
        legacyTopLevelKeysKept: [
          "citations",
          "availableCitations",
          "meteredLlmCalls",
        ].filter((key) => key in snapshot),
        legacyTracePartInputsKept: asRecords(snapshot.traceParts).filter(
          (part) => "input" in part || "text" in part,
        ).length,
      },
      null,
      2,
    ),
  );
  assertSlimAssistantMessage(snapshot.assistantMessage);
  assert.equal(snapshot.assistantMessage?.id, assistantMessage.id);
  assert.equal(snapshot.assistantMessage?.content, synthetic.report);
  assert.equal(snapshot.assistantMessage?.metadata.finishReason, "stop");
  assert.ok(
    after.textBytes < before.textBytes - before.keys.assistantMessage! / 2,
    `snapshot text went from ${before.textBytes} to ${after.textBytes} bytes`,
  );
  assert.ok(after.compressed < before.compressed);

  // Committed state survives: every tool call with its output, every render
  // block, and the artifact known only to the legacy embedded copy.
  const persistedToolCalls = asRecords(snapshot.toolCalls);
  for (const call of toolCalls) {
    const kept = persistedToolCalls.find((item) => item.id === call.id);
    assert.ok(kept, `${call.id} lost`);
    assert.deepEqual(kept.output, call.output);
    assert.deepEqual(kept.input, call.input);
  }
  assert.deepEqual(
    persistedToolCalls.find((item) => item.id === artifactCall.id),
    artifactCall,
  );
  const persistedBlocks = asRecords(snapshot.renderBlocks);
  for (const block of synthetic.renderBlocks) {
    assert.deepEqual(
      persistedBlocks.find((item) => item.id === block.id),
      block,
    );
  }
  assert.deepEqual(
    persistedBlocks.find((item) => item.id === artifactBlock.id),
    artifactBlock,
  );
  const message = (await messages.findMessageRecord({
    teamId,
    workspaceId,
    messageId: assistantMessage.id,
  }))!;
  assert.deepEqual(
    asRecords(message.metadata.renderBlocks).find(
      (item) => item.id === artifactBlock.id,
    ),
    artifactBlock,
    "the committed artifact block is synced to the messages row",
  );

  // Retrieval of an old row still reads through the legacy top-level lists.
  const readBack = snapshotModule.readSnapshotRetrieval(snapshot);
  assert.ok(readBack);
  assert.equal(readBack.availableCitations.length, 177);
  assert.equal(readBack.citations.length, USED_CITATION_COUNT);
  assertCitationRenderFields(asRecords(readBack.availableCitations));
  assertCitationRenderFields(asRecords(readBack.citations));

  // The old messages row is served without its legacy copies too.
  const { view } = await readClientAssistantMessage(assistantMessage.id);
  assertClientViewHasNoCopies(view.metadata);
  assert.equal(
    asRecords(view.metadata.renderBlocks).filter(
      (block) => block.type === "reasoning",
    ).length,
    38,
  );
}, 120_000);

// ---------------------------------------------------------------------------
// Sandbox-heavy run (live run 35e25891, Issue #333 reopened)
// ---------------------------------------------------------------------------

/**
 * Every sandbox tool output (`execute`, `prepare_sandbox_workspace`,
 * `collect_sandbox_outputs`) carries the message's whole operation timeline as
 * of that call (`appendSandboxOperationTimeline`, `listMessageOperations`
 * limit 50), so inline storage grows quadratically with the command count.
 * The live run stored 746,672 chars of operations in a 729,054 B snapshot at
 * 39 executes; this run has 84 executes and 6 prepares.
 */
const SANDBOX_STEP_COUNT = 30;
const SANDBOX_CALLS_PER_STEP = 3;
const SANDBOX_CALL_COUNT = SANDBOX_STEP_COUNT * SANDBOX_CALLS_PER_STEP;
/** Calls that run `prepare_sandbox_workspace`; every other call is `execute`. */
const PREPARE_CALLS = new Set([0, 15, 30, 45, 60, 75]);
const EXECUTE_CALL_COUNT = SANDBOX_CALL_COUNT - PREPARE_CALLS.size;
const OPERATION_TIMELINE_LIMIT = 50;
const SANDBOX_THINKING_STEPS = new Set([0, 6, 12, 18, 24]);
const SANDBOX_METERED_CALL_COUNT = SANDBOX_STEP_COUNT + 1;
const SANDBOX_REASONING_DELTA_CHARS = 40;
const SANDBOX_REPORT_CHARS = 4_000;
const CLIENT_VIEW_LIMIT = 640 * 1_024;
/** A structure-only trace event (`projectToolCallTraceEvent`), see below. */
const TRACE_EVENT_BYTES = 360;
/** The quadratic inline shape must be far beyond every bound below. */
const INLINE_OPERATIONS_MIN_BYTES = 2 * 1_024 * 1_024;

type SandboxOperation = {
  operationType: "prepare" | "execute";
  status: "succeeded";
  createdAt: string;
  durationMs: number;
  result: { exitCode: number; output: string; outputTruncated: boolean };
};

type SandboxRunStep = {
  segment: ModelReasoningSegmentTrace;
  thinking: ThinkingStepTrace[];
  calls: ToolCallTrace[];
};

type SandboxRun = {
  steps: SandboxRunStep[];
  toolCalls: ToolCallTrace[];
  /** Every distinct operation, in creation order (one per sandbox call). */
  operations: SandboxOperation[];
  thinkingSteps: ThinkingStepTrace[];
  meteredLlmCalls: MeteredLlmCallTrace[];
  renderBlocks: MessageRenderBlock[];
  reasoning: string;
  report: string;
};

/** A serialized LangChain ToolMessage, as the sandbox tools return it. */
function sandboxToolMessage(input: {
  toolCallId: string;
  name: string;
  content: string;
  operations: SandboxOperation[];
}) {
  return {
    name: input.name,
    type: "tool",
    status: "success",
    content: input.content,
    metadata: {},
    lc_kwargs: {
      id: `tool-message-${input.toolCallId}`,
      name: input.name,
      status: "success",
      content: input.content,
      metadata: {},
      tool_call_id: input.toolCallId,
      additional_kwargs: {},
      response_metadata: {},
    },
    operations: input.operations,
    lc_namespace: ["langchain_core", "messages"],
    tool_call_id: input.toolCallId,
    lc_serializable: true,
    additional_kwargs: {},
    response_metadata: {},
  };
}

function buildSandboxRun(input: {
  userMessageId: string;
  seed: number;
}): SandboxRun {
  const random = createRandom(input.seed);
  const gatewayConfigId = `gateway-${randomUUID()}`;
  let sequence = 0;
  const nextSequence = () => ++sequence;
  const steps: SandboxRunStep[] = [];
  const toolCalls: ToolCallTrace[] = [];
  const operations: SandboxOperation[] = [];
  const thinkingSteps: ThinkingStepTrace[] = [];
  const renderBlocks: MessageRenderBlock[] = [];
  let reasoning = "";

  // One more step than tool steps: the last model call writes the report.
  for (let step = 0; step <= SANDBOX_STEP_COUNT; step++) {
    const previous = toolCalls.at(-1);
    const text = prose(random, 500 + ((step * 211) % 400));
    reasoning += text;
    const segment: ModelReasoningSegmentTrace = {
      id: `model-reasoning-${step + 1}`,
      text,
      sequence: nextSequence(),
      durationMs: 1_200 + text.length * 3,
      ...(previous
        ? {
            phase: "after_tool" as const,
            toolCallId: previous.id,
            tool: previous.tool,
          }
        : { phase: "initial" as const }),
    };
    renderBlocks.push({
      id: `reasoning-${segment.id}`,
      type: "reasoning",
      text,
      durationMs: segment.durationMs,
    });
    const thinking: ThinkingStepTrace[] = SANDBOX_THINKING_STEPS.has(step)
      ? [
          {
            id: `thinking-step-${step + 1}`,
            kind: "log",
            title: `Checking ${prose(random, 30)}`,
            status: "completed",
            items: [prose(random, 64), prose(random, 48)],
            sequence: nextSequence(),
            description: prose(random, 90),
          },
        ]
      : [];
    thinkingSteps.push(...thinking);
    const calls: ToolCallTrace[] = [];
    if (step < SANDBOX_STEP_COUNT) {
      for (let slot = 0; slot < SANDBOX_CALLS_PER_STEP; slot++) {
        const index = toolCalls.length;
        const id = `call_${String(index).padStart(2, "0")}_${randomUUID().slice(0, 12)}`;
        const prepare = PREPARE_CALLS.has(index);
        const tool = prepare ? "prepare_sandbox_workspace" : "execute";
        const operation: SandboxOperation = {
          operationType: prepare ? "prepare" : "execute",
          status: "succeeded",
          createdAt: new Date(1_790_000_000_000 + index * 41_000).toISOString(),
          durationMs: 150 + Math.floor(random() * 9_000),
          result: {
            exitCode: 0,
            output: prose(random, 400 + ((index * 389) % 700), 96),
            outputTruncated: false,
          },
        };
        operations.push(operation);
        const stdout = prose(random, 1_024 + ((index * 577) % 2_048), 96);
        const call: ToolCallTrace = {
          id,
          tool,
          input: prepare
            ? {
                files: [
                  {
                    sourcePath: `/workspace/data/part-${index}.csv`,
                    targetPath: `/home/user/work/data/part-${index}.csv`,
                  },
                ],
              }
            : {
                command: `cd /home/user/work && python3 scripts/aggregate.py --input data/part-${index}.csv --format table`,
              },
          output: sandboxToolMessage({
            toolCallId: id,
            name: tool,
            content: `${stdout}\n\n[Command succeeded with exit code 0]`,
            // The timeline as of this call, capped to the latest 50.
            operations: operations.slice(-OPERATION_TIMELINE_LIMIT),
          }),
          status: "completed",
          latencyMs: operation.durationMs + 60,
          error: null,
          sequence: nextSequence(),
        };
        calls.push(call);
        toolCalls.push(call);
        renderBlocks.push({ id: `tool-${id}`, type: "tool", toolCallId: id });
      }
    }
    steps.push({ segment, thinking, calls });
  }

  const report = prose(random, SANDBOX_REPORT_CHARS, 110);
  renderBlocks.push({
    id: `text-${renderBlocks.length + 1}`,
    type: "text",
    text: report,
  });
  const meteredLlmCalls = Array.from(
    { length: SANDBOX_METERED_CALL_COUNT },
    (_, index) =>
      buildMeteredCall({
        index,
        random,
        userMessageId: input.userMessageId,
        gatewayConfigId,
      }),
  );

  assert.equal(toolCalls.length, SANDBOX_CALL_COUNT);
  assert.equal(
    toolCalls.filter((call) => call.tool === "execute").length,
    EXECUTE_CALL_COUNT,
  );
  return {
    steps,
    toolCalls,
    operations,
    thinkingSteps,
    meteredLlmCalls,
    renderBlocks,
    reasoning,
    report,
  };
}

async function* scriptedSandboxTurn(
  run: SandboxRun,
  counts: Record<string, number>,
): AsyncGenerator<DeepAgentTurnEvent> {
  const count = (type: string) => {
    counts[type] = (counts[type] ?? 0) + 1;
  };
  for (const { segment, thinking, calls } of run.steps) {
    let streamed = "";
    const deltas = chunk(segment.text, SANDBOX_REASONING_DELTA_CHARS);
    for (const [index, delta] of deltas.entries()) {
      streamed += delta;
      count("reasoning");
      yield {
        type: "reasoning",
        reasoning: delta,
        segment: {
          ...segment,
          text: streamed,
          durationMs:
            index === deltas.length - 1
              ? segment.durationMs
              : Math.floor(((segment.durationMs ?? 0) * index) / deltas.length),
        },
      };
    }
    for (const item of thinking) {
      count("thinking-step");
      yield {
        type: "thinking-step",
        step: { ...item, status: "in_progress", items: item.items.slice(0, 1) },
      };
    }
    for (const call of calls) {
      const running: ToolCallTrace = {
        ...call,
        output: null,
        status: "running",
        latencyMs: null,
      };
      count("tool-call-start");
      yield {
        type: "tool-call-start",
        id: call.id,
        tool: call.tool,
        input: call.input,
        toolCall: running,
      };
      count("tool-call-result");
      yield {
        type: "tool-call-result",
        id: call.id,
        tool: call.tool,
        input: call.input,
        output: call.output,
        latencyMs: call.latencyMs,
        toolCall: call,
      };
      count("tool-call-end");
      yield {
        type: "tool-call-end",
        id: call.id,
        tool: call.tool,
        latencyMs: call.latencyMs,
        status: "completed",
        toolCall: call,
      };
    }
    for (const item of thinking) {
      count("thinking-step");
      yield { type: "thinking-step", step: item };
    }
  }
  for (const delta of chunk(run.report, TEXT_DELTA_CHARS)) {
    count("text-delta");
    yield { type: "text-delta", delta };
  }
  const usage = run.meteredLlmCalls.reduce(
    (sum, call) => ({
      inputTokens: sum.inputTokens + (call.usage?.inputTokens ?? 0),
      outputTokens: sum.outputTokens + (call.usage?.outputTokens ?? 0),
      totalTokens: sum.totalTokens + (call.usage?.totalTokens ?? 0),
    }),
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  );
  yield {
    type: "done",
    outcome: {
      assistantContent: run.report,
      retrieval: null,
      citations: [],
      availableCitations: [],
      retrievalCalls: [],
      toolCalls: run.toolCalls,
      meteredLlmCalls: run.meteredLlmCalls,
      thinkingSteps: run.thinkingSteps,
      renderBlocks: run.renderBlocks,
      reasoningSegments: run.steps.map((step) => step.segment),
      usage,
      finishReason: "stop",
      reasoning: run.reasoning,
      agentCheckpoint: {
        beforeInput: null,
        beforeAssistant: null,
        resume: null,
        final: null,
      },
    },
  };
}

type StoredToolCallShape = {
  hasPool: boolean;
  poolLength: number | null;
  toolCalls: number;
  inlineOutputs: number;
  refOutputs: number;
  /** Position of any `"operations"` key anywhere in the stored JSON, 0 if none. */
  operationsKeyAt: number;
  compressed: number;
  textBytes: number;
};

/** The stored JSON as PostgreSQL holds it, bypassing the column type. */
async function readStoredToolCallShape(
  table: "chat_thread_runs" | "messages",
  id: string,
): Promise<StoredToolCallShape> {
  const column = table === "chat_thread_runs" ? "snapshot_json" : "metadata";
  const {
    rows: [row],
  } = await schema.database.query<Record<string, unknown>>(
    `select
       ${column} ? 'toolCallOperationPool' as has_pool,
       case when jsonb_typeof(${column}->'toolCallOperationPool') = 'array'
         then jsonb_array_length(${column}->'toolCallOperationPool') end as pool_length,
       jsonb_array_length(${column}->'toolCalls') as tool_calls,
       (select count(*) from jsonb_array_elements(${column}->'toolCalls') as call
         where jsonb_typeof(call->'output') = 'object'
           and call->'output' ? 'operations') as inline_outputs,
       (select count(*) from jsonb_array_elements(${column}->'toolCalls') as call
         where jsonb_typeof(call->'output') = 'object'
           and call->'output' ? 'operationRefs') as ref_outputs,
       position('"operations"' in ${column}::text) as operations_key_at,
       pg_column_size(${column}) as compressed,
       octet_length(${column}::text) as text_bytes
     from ${table} where id = $1`,
    [id],
  );
  assert.ok(row, `${table} ${id} missing`);
  return {
    hasPool: row.has_pool === true,
    poolLength: row.pool_length === null ? null : Number(row.pool_length),
    toolCalls: Number(row.tool_calls),
    inlineOutputs: Number(row.inline_outputs),
    refOutputs: Number(row.ref_outputs),
    operationsKeyAt: Number(row.operations_key_at),
    compressed: Number(row.compressed),
    textBytes: Number(row.text_bytes),
  };
}

function assertPooledStorage(
  shape: StoredToolCallShape,
  run: SandboxRun,
  label: string,
) {
  assert.equal(shape.hasPool, true, `${label} has no toolCallOperationPool`);
  assert.equal(
    shape.poolLength,
    run.operations.length,
    `${label} pool holds each distinct operation once`,
  );
  assert.equal(shape.toolCalls, SANDBOX_CALL_COUNT, `${label} toolCalls`);
  assert.equal(shape.inlineOutputs, 0, `${label} stores inline operations`);
  assert.equal(shape.refOutputs, SANDBOX_CALL_COUNT, `${label} operationRefs`);
  assert.equal(
    shape.operationsKeyAt,
    0,
    `${label} stores an "operations" key outside the pool`,
  );
}

/** Every tool call reads back exactly as streamed (Run command card input). */
function assertToolCallsAsStreamed(
  record: Record<string, unknown>,
  run: SandboxRun,
  label: string,
) {
  assert.equal(
    "toolCallOperationPool" in record,
    false,
    `${label} exposes the storage pool`,
  );
  const stored = asRecords(record.toolCalls);
  assert.equal(stored.length, SANDBOX_CALL_COUNT, `${label} toolCalls`);
  for (const call of run.toolCalls) {
    const item = stored.find((candidate) => candidate.id === call.id);
    assert.ok(item, `${label} ${call.id} missing`);
    const output = item.output as Record<string, unknown>;
    const streamed = call.output as Record<string, unknown>;
    assert.equal("operationRefs" in output, false, `${label} ${call.id} refs`);
    assert.deepEqual(
      output.operations,
      streamed.operations,
      `${label} ${call.id} operations`,
    );
    assert.equal(output.content, streamed.content, `${label} ${call.id}`);
    assert.deepEqual(
      output.lc_kwargs,
      streamed.lc_kwargs,
      `${label} lc_kwargs`,
    );
    assert.deepEqual(output, streamed, `${label} ${call.id} output`);
    assert.deepEqual(item.input, call.input, `${label} ${call.id} input`);
  }
}

/** Bytes of each tool output's `operations` as stored without the pool. */
function inlineOperationBytes(run: SandboxRun) {
  return run.toolCalls.reduce(
    (sum, call) =>
      sum + bytes((call.output as Record<string, unknown>).operations),
    0,
  );
}

function outputWithoutOperations(call: ToolCallTrace) {
  const { operations: _operations, ...rest } = call.output as Record<
    string,
    unknown
  >;
  return rest;
}

test("a sandbox-heavy run stores each sandbox operation once and reads every timeline back unchanged", async () => {
  const run = await createRun();
  const counts: Record<string, number> = {};
  let appended = 0;
  vi.spyOn(streams.chatRunStreamManager, "subscribeCancel").mockResolvedValue(
    async () => {},
  );
  vi.spyOn(streams.chatRunStreamManager, "appendEvent").mockImplementation(
    async () => ++appended,
  );
  const { ContentThreadStreamService } =
    await vi.importActual<typeof import("../stream/service")>(
      "../stream/service",
    );
  const { ContentThreadTurnService } = await import("../turn/service");
  const billing = createBillingPort();
  const turnService = new ContentThreadTurnService(billing);
  let synthetic: SandboxRun | undefined;
  const streamService = new ContentThreadStreamService(
    {
      prepareThreadTurn: async () => {
        const userMessage = await messages.createMessageRecord({
          teamId,
          workspaceId,
          threadId,
          role: "user",
          content: "Aggregate the quarterly data in the sandbox.",
          createdBy: null,
        });
        synthetic = buildSandboxRun({
          userMessageId: userMessage.id,
          seed: 35_025_891,
        });
        return preparedTurn({ run, userMessage });
      },
      finalizeThreadTurn: (
        command: Parameters<typeof turnService.finalizeThreadTurn>[0],
      ) => turnService.finalizeThreadTurn(command),
    } as unknown as ConstructorParameters<typeof ContentThreadStreamService>[0],
    () => scriptedSandboxTurn(synthetic!, counts),
    async () => null,
    undefined,
    billing,
  );
  mocked.stream.mockImplementation(
    (...args: Parameters<typeof streamService.streamThreadEvents>) =>
      streamService.streamThreadEvents(...args),
  );

  const startedAt = Date.now();
  const result = await runner.processThreadChatRunJob({
    runId: run.id,
    teamId,
    workspaceId,
    threadId,
    userId,
  });
  const elapsedMs = Date.now() - startedAt;
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.ok(synthetic);
  assert.ok(result.assistantMessageId);
  assert.equal(counts["tool-call-result"], SANDBOX_CALL_COUNT);
  const inlineBytes = inlineOperationBytes(synthetic);
  const operationRefCount = synthetic.toolCalls.reduce(
    (sum, call) =>
      sum +
      asRecords((call.output as Record<string, unknown>).operations).length,
    0,
  );
  assert.ok(
    inlineBytes > INLINE_OPERATIONS_MIN_BYTES,
    `inline operations are only ${inlineBytes} bytes`,
  );

  // 1. The snapshot stores each distinct operation once.
  const snapshotShape = await readStoredToolCallShape(
    "chat_thread_runs",
    run.id,
  );
  assert.ok(
    snapshotShape.compressed < SNAPSHOT_COMPRESSED_LIMIT,
    `pg_column_size(snapshot_json) is ${snapshotShape.compressed} bytes`,
  );
  assertPooledStorage(snapshotShape, synthetic, "snapshot_json");

  // 2. So does the messages row, within a bound derived from the run's payload.
  const messageShape = await readStoredToolCallShape(
    "messages",
    result.assistantMessageId,
  );
  assertPooledStorage(messageShape, synthetic, "messages.metadata");
  /**
   * The messages row stores, each once: the tool inputs and outputs without
   * `operations` (a ToolMessage keeps `content` twice, top level and
   * `lc_kwargs`), the operation pool, the reasoning twice (`reasoning` and
   * its render blocks), the thinking steps, the metering list (design D1)
   * and the report's text block. Around that payload: one `operationRefs`
   * index per timeline entry (≤ 4 B each), per-item structure (ids, kinds,
   * sequences, statuses, punctuation) at the allowances measured on the long
   * report run above, and the structure-only `traceEvents` (three per tool
   * call, one per reasoning segment, two per thinking step; measured ~311 B
   * each here, allowed 360 B). The structure allowance gets 25% headroom:
   * measured on this fixture, structure is ~194 KB against ~252 KB allowed,
   * so the bound sits ~7% above the ~852 KB text. The bound applies to the
   * text form; the compressed jsonb must also fit it. Inline operations add
   * ~2.9 MB, so a row that stores them fails it several times over.
   */
  const toolPayloadBytes = synthetic.toolCalls.reduce(
    (sum, call) =>
      sum + bytes(call.input) + bytes(outputWithoutOperations(call)),
    0,
  );
  const messagePayloadBytes =
    toolPayloadBytes +
    bytes(synthetic.operations) +
    2 * bytes(synthetic.reasoning) +
    bytes(synthetic.thinkingSteps) +
    bytes(synthetic.meteredLlmCalls) +
    bytes(synthetic.report);
  const messageStructureAllowance =
    operationRefCount * 4 +
    SANDBOX_CALL_COUNT *
      (STRUCTURE_BYTES.toolCall + STRUCTURE_BYTES.tracePart) +
    synthetic.renderBlocks.length * STRUCTURE_BYTES.renderBlock +
    synthetic.steps.length *
      (STRUCTURE_BYTES.reasoningSegment + STRUCTURE_BYTES.tracePart) +
    (3 * SANDBOX_CALL_COUNT +
      synthetic.steps.length +
      2 * synthetic.thinkingSteps.length) *
      TRACE_EVENT_BYTES +
    STRUCTURE_BYTES.fixed;
  const messageBound = Math.ceil(
    messagePayloadBytes + messageStructureAllowance * 1.25,
  );

  // 3. The app's read paths restore every timeline exactly as streamed.
  const persisted = (await repository.findChatThreadRunById({
    runId: run.id,
    teamId,
    workspaceId,
  }))!;
  assert.equal(persisted.status, "completed");
  assertToolCallsAsStreamed(
    persisted.snapshotJson,
    synthetic,
    "findChatThreadRunById",
  );
  const found = await messages.findMessageRecord({
    teamId,
    workspaceId,
    messageId: result.assistantMessageId,
  });
  assert.ok(found);
  assertToolCallsAsStreamed(found.metadata, synthetic, "findMessageRecord");
  const { stored, view } = await readClientAssistantMessage(
    result.assistantMessageId,
  );
  assertToolCallsAsStreamed(
    stored.metadata,
    synthetic,
    "listMessageRecordPageByThread",
  );
  assert.deepEqual(stored.metadata, found.metadata);
  assert.equal(stored.content, synthetic.report);

  // 4. The /messages wire stays compact and expands back to the stored shape.
  const viewBytes = bytes(view);
  const viewPool = asRecords(view.metadata.toolCallOperationPool);
  assert.equal(viewPool.length, synthetic.operations.length);
  for (const call of asRecords(view.metadata.toolCalls)) {
    const output = call.output as Record<string, unknown>;
    assert.equal("operations" in output, false, `${call.id} inline in view`);
    assert.ok(Array.isArray(output.operationRefs), `${call.id} view refs`);
  }
  const expanded = expandToolCallOutputsFromClient(view.metadata);
  assert.deepEqual(expanded.toolCalls, stored.metadata.toolCalls);
  assert.equal("toolCallOperationPool" in expanded, false);
  // Apart from what the view drops or projects (see message-client-view.ts;
  // the client sanitizer drops `reasoningWrite`), every metadata field is
  // the stored one.
  const projectedKeys = new Set(["traceParts", "reasoningSegments"]);
  const droppedKeys = new Set([
    "meteredLlmCalls",
    "reasoning",
    "reasoningWrite",
    "traceEvents",
  ]);
  for (const key of Object.keys(stored.metadata)) {
    if (droppedKeys.has(key) || projectedKeys.has(key)) continue;
    assert.deepEqual(expanded[key], stored.metadata[key], `view ${key}`);
  }
  for (const key of Object.keys(expanded)) {
    assert.ok(key in stored.metadata, `view adds ${key}`);
  }

  console.log(
    "[#333 size bounds] sandbox-heavy run",
    JSON.stringify(
      {
        elapsedMs,
        appendedEvents: appended,
        streamedEvents: counts,
        sandboxCalls: SANDBOX_CALL_COUNT,
        distinctOperations: synthetic.operations.length,
        operationRefs: operationRefCount,
        inlineEquivalent: {
          operationsBytes: inlineBytes,
          toolCallsBytes: bytes(synthetic.toolCalls),
          distinctOperationBytes: bytes(synthetic.operations),
        },
        snapshot: {
          pgColumnSize: snapshotShape.compressed,
          textBytes: snapshotShape.textBytes,
          limit: SNAPSHOT_COMPRESSED_LIMIT,
        },
        messagesRow: {
          pgColumnSize: messageShape.compressed,
          textBytes: messageShape.textBytes,
          bound: messageBound,
          payloadBytes: messagePayloadBytes,
          structureAllowance: messageStructureAllowance,
          // As read back: `toolCalls` here is the expanded, inline shape.
          readBackMetadata: metadataBreakdown(found.metadata),
        },
        clientView: {
          bytes: viewBytes,
          limit: CLIENT_VIEW_LIMIT,
          metadata: metadataBreakdown(view.metadata),
        },
      },
      null,
      2,
    ),
  );
  assert.ok(
    messageShape.textBytes < messageBound,
    `messages.metadata text is ${messageShape.textBytes} bytes, bound ${messageBound}`,
  );
  assert.ok(
    messageShape.compressed < messageBound,
    `pg_column_size(messages.metadata) is ${messageShape.compressed} bytes, bound ${messageBound}`,
  );
  assert.ok(messageBound < inlineBytes / 2);
  assert.ok(
    viewBytes < CLIENT_VIEW_LIMIT,
    `/messages assistant view is ${viewBytes} bytes`,
  );
}, 600_000);

test("rows stored with inline sandbox operations read unchanged and pool on their next write", async () => {
  const run = await createRun();
  const running = await repository.markChatThreadRunRunning({
    runId: run.id,
    teamId,
    workspaceId,
  });
  assert.equal(running?.status, "running");
  const userMessage = await messages.createMessageRecord({
    teamId,
    workspaceId,
    threadId,
    role: "user",
    content: "Aggregate the quarterly data in the sandbox.",
    createdBy: null,
  });
  const synthetic = buildSandboxRun({
    userMessageId: userMessage.id,
    seed: 333_035,
  });
  const segments = synthetic.steps.map((step) => step.segment);
  const oldMetadata: Record<string, unknown> = {
    userMessageId: userMessage.id,
    sourceUserMessageId: userMessage.id,
    traceId: run.id,
    threadRun: { id: run.id, status: "running", mode: "send" },
    modelAlias: "deepseek-v4-pro",
    finishReason: "stop",
    toolCalls: synthetic.toolCalls,
    thinkingSteps: synthetic.thinkingSteps,
    reasoning: synthetic.reasoning,
    reasoningSegments: segments,
    renderBlocks: synthetic.renderBlocks,
  };
  const assistantMessage = await messages.createMessageRecord({
    teamId,
    workspaceId,
    threadId,
    parentMessageId: userMessage.id,
    role: "assistant",
    content: synthetic.report,
    createdBy: null,
    model: "deepseek-v4-pro",
  });
  const oldSnapshot: Record<string, unknown> = {
    reasoningRun: { runId: run.id, parentRunId: null, base: "" },
    reasoningRevision: 900,
    assistantContent: synthetic.report,
    reasoningSegments: segments,
    toolCalls: synthetic.toolCalls,
    thinkingSteps: synthetic.thinkingSteps,
    renderBlocks: synthetic.renderBlocks,
    lastEventType: "tool-call-end",
  };
  // Raw SQL: the column type would pool these; old rows hold them inline.
  await schema.database.query(
    "update messages set metadata = $1::jsonb where id = $2",
    [JSON.stringify(oldMetadata), assistantMessage.id],
  );
  await schema.database.query(
    "update chat_thread_runs set snapshot_json = $1::jsonb, user_message_id = $2, assistant_message_id = $3 where id = $4",
    [JSON.stringify(oldSnapshot), userMessage.id, assistantMessage.id, run.id],
  );
  const snapshotBefore = await readStoredToolCallShape(
    "chat_thread_runs",
    run.id,
  );
  const messageBefore = await readStoredToolCallShape(
    "messages",
    assistantMessage.id,
  );
  for (const shape of [snapshotBefore, messageBefore]) {
    assert.equal(shape.hasPool, false);
    assert.equal(shape.inlineOutputs, SANDBOX_CALL_COUNT);
  }

  // Old rows read as stored.
  const readRun = async () =>
    (await repository.findChatThreadRunById({
      runId: run.id,
      teamId,
      workspaceId,
    }))!;
  const readMessage = async () =>
    (await messages.findMessageRecord({
      teamId,
      workspaceId,
      messageId: assistantMessage.id,
    }))!;
  assert.deepEqual((await readRun()).snapshotJson, oldSnapshot);
  const oldRow = await readMessage();
  assert.deepEqual(oldRow.metadata, oldMetadata);
  assertToolCallsAsStreamed(oldRow.metadata, synthetic, "old messages row");

  // One write through each repository pools the row.
  const updated = await messages.updateMessageMetadataRecord({
    teamId,
    workspaceId,
    threadId,
    messageId: assistantMessage.id,
    metadata: oldRow.metadata,
  });
  assert.ok(updated);
  assert.deepEqual(updated.metadata, oldMetadata);
  await repository.updateChatThreadRunProgress({
    runId: run.id,
    teamId,
    workspaceId,
    eventOffset: 1,
    snapshotJson: { lastEventType: "thinking-step" },
    returnRecord: false,
  });

  const snapshotAfter = await readStoredToolCallShape(
    "chat_thread_runs",
    run.id,
  );
  const messageAfter = await readStoredToolCallShape(
    "messages",
    assistantMessage.id,
  );
  console.log(
    "[#333 size bounds] inline sandbox operations row",
    JSON.stringify(
      {
        snapshot: {
          before: {
            pgColumnSize: snapshotBefore.compressed,
            textBytes: snapshotBefore.textBytes,
          },
          after: {
            pgColumnSize: snapshotAfter.compressed,
            textBytes: snapshotAfter.textBytes,
          },
        },
        messagesRow: {
          before: {
            pgColumnSize: messageBefore.compressed,
            textBytes: messageBefore.textBytes,
          },
          after: {
            pgColumnSize: messageAfter.compressed,
            textBytes: messageAfter.textBytes,
          },
        },
      },
      null,
      2,
    ),
  );
  assertPooledStorage(snapshotAfter, synthetic, "rewritten snapshot_json");
  assertPooledStorage(messageAfter, synthetic, "rewritten messages.metadata");
  assert.ok(snapshotAfter.textBytes < snapshotBefore.textBytes / 4);
  assert.ok(messageAfter.textBytes < messageBefore.textBytes / 4);

  // And still read back unchanged.
  assert.deepEqual((await readMessage()).metadata, oldMetadata);
  const rewritten = (await readRun()).snapshotJson;
  assertToolCallsAsStreamed(rewritten, synthetic, "rewritten snapshot");
  assert.equal(rewritten.lastEventType, "thinking-step");
}, 120_000);
