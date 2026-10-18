import type { FakeScenario } from "./fake-openai-sse-server";
import type { HandlerShape } from "./stream-characterization-harness";

/**
 * `invoke` is recorded under both of core's internal streaming paths (see
 * `HandlerShape`); `invoke/v3` is the one the agent runtime actually drives.
 */
export const GOLDEN_ENTRIES: ReadonlyArray<{
  key: string;
  entry: "invoke" | "stream";
  handlerShape: HandlerShape;
}> = [
  { key: "invoke", entry: "invoke", handlerShape: "llm-new-token" },
  { key: "stream", entry: "stream", handlerShape: "llm-new-token" },
  {
    key: "invoke/v3",
    entry: "invoke",
    handlerShape: "chat-model-stream-events",
  },
];

export type GoldenScenario = {
  name: string;
  scenario: FakeScenario;
  timeoutMs: number;
  tools?: boolean;
  thinking?: boolean;
};

const usage = {
  prompt_tokens: 12,
  completion_tokens: 7,
  total_tokens: 19,
  completion_tokens_details: { reasoning_tokens: 3 },
};

/** Golden-sequence scenarios: the event shapes the backend consumes. */
export const GOLDEN_SCENARIOS: GoldenScenario[] = [
  {
    name: "plain-text",
    timeoutMs: 5_000,
    scenario: {
      kind: "stream",
      chunks: [
        { content: "Hel" },
        { content: "lo" },
        { content: "", finishReason: "stop" },
      ],
    },
  },
  {
    name: "reasoning-text",
    timeoutMs: 5_000,
    thinking: true,
    scenario: {
      kind: "stream",
      chunks: [
        { reasoning: "Let me" },
        { reasoning: " think." },
        { content: "Answer" },
        { content: "", finishReason: "stop" },
      ],
      usage,
    },
  },
  {
    name: "tool-call-deltas",
    timeoutMs: 5_000,
    tools: true,
    scenario: {
      kind: "stream",
      chunks: [
        { toolCalls: [{ index: 0, id: "call_1", name: "lookup", args: "" }] },
        { toolCalls: [{ index: 0, args: '{"q":' }] },
        { toolCalls: [{ index: 0, args: '"x"}' }] },
        { content: "", finishReason: "tool_calls" },
      ],
      usage,
    },
  },
  {
    name: "finish-with-usage",
    timeoutMs: 5_000,
    scenario: {
      kind: "stream",
      chunks: [{ content: "ok" }, { content: "", finishReason: "stop" }],
      usage,
    },
  },
  {
    name: "provider-5xx",
    timeoutMs: 5_000,
    scenario: {
      kind: "status",
      status: 503,
      body: { error: { message: "fake upstream unavailable" } },
    },
  },
  {
    name: "first-token-timeout",
    timeoutMs: 400,
    scenario: {
      kind: "stream",
      firstTokenDelayMs: 2_000,
      chunks: [{ content: "late" }, { content: "", finishReason: "stop" }],
    },
  },
];
