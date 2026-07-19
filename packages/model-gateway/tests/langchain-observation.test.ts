import assert from "node:assert/strict";
import test from "node:test";
import { createLangChainChatModel } from "../src/bridge/utils";
import type {
  LangChainChatModelLike,
  ModelGatewayConfig,
  ObserveGenerationEnd,
  ObserveSink,
} from "../src/types";

type Captured = {
  ends: ObserveGenerationEnd[];
  starts: unknown[];
};

/**
 * A stand-in chat model exposing the full surface langchain drives: invoke,
 * stream, bindTools and withStructuredOutput.
 */
function createFakeModel(calls: string[]): LangChainChatModelLike {
  const model: LangChainChatModelLike = {
    getName: () => "fake-model",
    invoke: async () => {
      calls.push("invoke");
      return {
        content: "hello",
        usage_metadata: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
        response_metadata: { finish_reason: "stop" },
      };
    },
    stream: async () => {
      calls.push("stream");
      return (async function* () {
        yield {
          content: "hel",
          response_metadata: {},
        };
        yield {
          content: "lo",
          usage_metadata: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
          response_metadata: { finish_reason: "stop" },
        };
      })();
    },
    bindTools: () => {
      calls.push("bindTools");
      return model;
    },
    withStructuredOutput: () => {
      calls.push("withStructuredOutput");
      return {
        invoke: async () => {
          calls.push("structured.invoke");
          return {
            content: '{"ok":true}',
            usage_metadata: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
            response_metadata: { finish_reason: "stop" },
          };
        },
      };
    },
  };
  return model;
}

async function buildModel(calls: string[], captured: Captured) {
  const observeSink: ObserveSink = {
    onGenerationStart: (g) => {
      captured.starts.push(g);
    },
    onGenerationEnd: (g) => {
      captured.ends.push(g);
    },
  };

  const config = {
    providers: {
      openai: {
        kind: "openai-compatible",
        baseUrl: "https://example.invalid/v1",
        apiKey: "test",
      },
    },
    modelRoutes: {
      "test-model": {
        strategy: "priority",
        targets: [{ provider: "openai", model: "test-model", priority: 1 }],
      },
    },
    observeSink,
    langchainFactories: {
      createChatModel: () => createFakeModel(calls),
    },
  } as unknown as ModelGatewayConfig;

  return (await createLangChainChatModel({
    modelAlias: "test-model",
    config,
  })) as unknown as LangChainChatModelLike;
}

test("invoke emits exactly one generation with usage", async () => {
  const calls: string[] = [];
  const captured: Captured = { ends: [], starts: [] };
  const model = await buildModel(calls, captured);

  await model.invoke([{ role: "user", content: "hi" }]);

  assert.equal(captured.ends.length, 1);
  assert.equal(captured.ends[0]?.usage?.inputTokens, 10);
  assert.equal(captured.ends[0]?.usage?.outputTokens, 4);
});

// Regression: withStructuredOutput was never overridden by the previous
// Object.create-based shim, so structured calls produced zero generations and
// their usage was invisible to observability (and therefore to billing).
test("withStructuredOutput emits a generation", async () => {
  const calls: string[] = [];
  const captured: Captured = { ends: [], starts: [] };
  const model = await buildModel(calls, captured);

  const structured = model.withStructuredOutput!(
    { type: "object" },
    { includeRaw: true, name: "Result" },
  );
  await structured.invoke([{ role: "user", content: "hi" }]);

  assert.equal(captured.ends.length, 1);
  assert.equal(captured.ends[0]?.usage?.inputTokens, 7);
  assert.equal(captured.ends[0]?.usage?.outputTokens, 3);
});

test("withStructuredOutput emits exactly one generation, not one per layer", async () => {
  const calls: string[] = [];
  const captured: Captured = { ends: [], starts: [] };
  const model = await buildModel(calls, captured);

  const structured = model.withStructuredOutput!(
    { type: "object" },
    { includeRaw: true, name: "Result" },
  );
  await structured.invoke([{ role: "user", content: "hi" }]);

  assert.equal(captured.starts.length, 1);
  assert.equal(captured.ends.length, 1);
  // The structured runnable's own invoke ran; the model's plain invoke did not.
  assert.ok(calls.includes("structured.invoke"));
  assert.ok(!calls.includes("invoke"));
});

test("observation survives bindTools composition", async () => {
  const calls: string[] = [];
  const captured: Captured = { ends: [], starts: [] };
  const model = await buildModel(calls, captured);

  const bound = model.bindTools!([{ name: "t" }]);
  await bound.invoke([{ role: "user", content: "hi" }]);

  assert.equal(captured.ends.length, 1);
  assert.equal(captured.ends[0]?.usage?.inputTokens, 10);
});

test("observation survives bindTools then withStructuredOutput", async () => {
  const calls: string[] = [];
  const captured: Captured = { ends: [], starts: [] };
  const model = await buildModel(calls, captured);

  const bound = model.bindTools!([{ name: "t" }]);
  const structured = bound.withStructuredOutput!(
    { type: "object" },
    { includeRaw: true, name: "Result" },
  );
  await structured.invoke([{ role: "user", content: "hi" }]);

  assert.equal(captured.ends.length, 1);
  assert.equal(captured.ends[0]?.usage?.inputTokens, 7);
});

test("stream emits one generation with last-wins usage", async () => {
  const calls: string[] = [];
  const captured: Captured = { ends: [], starts: [] };
  const model = await buildModel(calls, captured);

  const stream = await model.stream([{ role: "user", content: "hi" }]);
  for await (const _chunk of stream as AsyncIterable<unknown>) {
    // drain
  }

  assert.equal(captured.ends.length, 1);
  assert.equal(captured.ends[0]?.usage?.outputTokens, 4);
});

test("pass-through properties still reach the underlying model", async () => {
  const calls: string[] = [];
  const captured: Captured = { ends: [], starts: [] };
  const model = await buildModel(calls, captured);

  assert.equal(model.getName?.(), "fake-model");
});
