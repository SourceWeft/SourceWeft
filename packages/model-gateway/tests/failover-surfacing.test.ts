import assert from "node:assert/strict";
import test from "node:test";
import { createModelGateway, TargetHealthRegistry } from "../src/index";
import type {
  ChatStreamEvent,
  LangChainChatModelLike,
  ModelCapabilityRule,
  ModelGatewayConfig,
} from "../src/types";

function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

/**
 * Priority-routed config with injectable fake models and controllable target
 * models per provider — the surfacing tests need same-model and
 * different-model chains, which the shared two-target helper hardcodes.
 */
function chainConfig(input: {
  targets: Array<{ provider: string; model: string }>;
  models: Record<string, () => LangChainChatModelLike>;
  providerKind?: "openai" | "deepseek";
  modelCapabilities?: ModelCapabilityRule[];
  onCreateModel?: (payload: { thinking?: { mode?: string } }) => void;
}): ModelGatewayConfig {
  return {
    baseUrl: "https://gateway.example.com",
    allowedModelAliases: ["chat-default"],
    targetHealth: new TargetHealthRegistry(),
    ...(input.modelCapabilities
      ? { modelCapabilities: input.modelCapabilities }
      : {}),
    providers: Object.fromEntries(
      input.targets.map((target) => [
        target.provider,
        {
          kind: input.providerKind ?? ("openai" as const),
          baseUrl: `https://${target.provider}.example.com/v1`,
          apiKey: `${target.provider}-key`,
        },
      ]),
    ),
    modelRoutes: {
      "chat-default": {
        strategy: "priority",
        targets: input.targets.map((target, index) => ({
          provider: target.provider,
          model: target.model,
          priority: index + 1,
        })),
      },
    },
    langchainFactories: {
      createChatModel: ({ target, payload }) => {
        input.onCreateModel?.(payload as { thinking?: { mode?: string } });
        return input.models[target.provider]!();
      },
    },
  };
}

function emptyStructuredModel(calls: string[], name: string) {
  return (): LangChainChatModelLike =>
    ({
      getName: () => name,
      invoke: async () => {
        throw new Error("plain invoke should not run in structured tests");
      },
      stream: async () => {
        throw new Error("stream should not run");
      },
      withStructuredOutput: () => ({
        invoke: async () => {
          calls.push(name);
          return { raw: { content: "" }, parsed: null };
        },
      }),
    }) as unknown as LangChainChatModelLike;
}

test("failover exhausted: an unfunded tail target's 402 does not mask the substantive error", async () => {
  const gateway = createModelGateway(
    chainConfig({
      targets: [
        { provider: "primary", model: "primary-model" },
        { provider: "backup", model: "backup-model" },
      ],
      models: {
        primary: () =>
          ({
            getName: () => "primary",
            invoke: async () => {
              throw httpError(500, "upstream exploded");
            },
          }) as unknown as LangChainChatModelLike,
        backup: () =>
          ({
            getName: () => "backup",
            invoke: async () => {
              throw httpError(402, "402 status code (no body)");
            },
          }) as unknown as LangChainChatModelLike,
      },
    }),
  );

  await assert.rejects(
    gateway.chat.complete({
      model: "chat-default",
      messages: [{ role: "user", content: "hi" }],
    }),
    (error: { code?: string; metadata?: Record<string, unknown> }) => {
      assert.equal(error.code, "UPSTREAM");
      const targetErrors = error.metadata?.targetErrors as Array<{
        code: string;
      }>;
      assert.equal(targetErrors.length, 2);
      assert.deepEqual(
        targetErrors.map((entry) => entry.code),
        ["UPSTREAM", "QUOTA"],
      );
      return true;
    },
  );
});

test("failover exhausted: with every account dead, QUOTA is surfaced honestly", async () => {
  const gateway = createModelGateway(
    chainConfig({
      targets: [
        { provider: "primary", model: "primary-model" },
        { provider: "backup", model: "backup-model" },
      ],
      models: {
        primary: () =>
          ({
            getName: () => "primary",
            invoke: async () => {
              throw httpError(402, "no balance");
            },
          }) as unknown as LangChainChatModelLike,
        backup: () =>
          ({
            getName: () => "backup",
            invoke: async () => {
              throw httpError(401, "bad key");
            },
          }) as unknown as LangChainChatModelLike,
      },
    }),
  );

  await assert.rejects(
    gateway.chat.complete({
      model: "chat-default",
      messages: [{ role: "user", content: "hi" }],
    }),
    (error: { code?: string }) => error.code === "QUOTA",
  );
});

test("structured-output failure skips same-model channels instead of replaying them", async () => {
  const calls: string[] = [];
  const gateway = createModelGateway(
    chainConfig({
      targets: [
        { provider: "primary", model: "shared-model" },
        { provider: "backup", model: "shared-model" },
      ],
      models: {
        primary: emptyStructuredModel(calls, "primary"),
        backup: emptyStructuredModel(calls, "backup"),
      },
    }),
  );

  await assert.rejects(
    gateway.chat.complete({
      model: "chat-default",
      messages: [{ role: "user", content: "hi" }],
      structuredOutput: {
        name: "result",
        schema: { type: "object", properties: {} },
      },
    }),
    (error: { code?: string }) => error.code === "STRUCTURED_OUTPUT",
  );
  // The same model through another channel is a deterministic replay — the
  // backup must not burn two minutes repeating it.
  assert.deepEqual(calls, ["primary"]);
});

test("structured-output failure still fails over to a genuinely different model", async () => {
  const calls: string[] = [];
  const gateway = createModelGateway(
    chainConfig({
      targets: [
        { provider: "primary", model: "primary-model" },
        { provider: "backup", model: "backup-model" },
      ],
      models: {
        primary: emptyStructuredModel(calls, "primary"),
        backup: () =>
          ({
            getName: () => "backup",
            withStructuredOutput: () => ({
              invoke: async () => {
                calls.push("backup");
                return { raw: { content: "{}" }, parsed: { ok: true } };
              },
            }),
          }) as unknown as LangChainChatModelLike,
      },
    }),
  );

  const result = await gateway.chat.complete({
    model: "chat-default",
    messages: [{ role: "user", content: "hi" }],
    structuredOutput: {
      name: "result",
      schema: { type: "object", properties: {} },
    },
  });

  assert.deepEqual(calls, ["primary", "backup"]);
  assert.deepEqual(result.structuredOutput, { ok: true });
});

test("structured output on a thinking-by-default model: 'auto' is translated to off, forced strategy behind a hard disable", async () => {
  const seenThinkingModes: Array<string | undefined> = [];
  let structuredCalls = 0;
  let bindToolsCalls = 0;
  const gateway = createModelGateway(
    chainConfig({
      providerKind: "deepseek",
      targets: [{ provider: "ds", model: "deepseek-v4-pro" }],
      modelCapabilities: [
        {
          modelMatch: "deepseek-v4-pro",
          capabilities: { forcedToolChoiceBlockedByThinking: true },
        },
      ],
      onCreateModel: (payload) => {
        seenThinkingModes.push(payload.thinking?.mode);
      },
      models: {
        ds: () =>
          ({
            getName: () => "ds",
            withStructuredOutput: () => {
              structuredCalls += 1;
              return {
                invoke: async () => ({
                  raw: { content: "{}" },
                  parsed: { ok: true },
                }),
              };
            },
            bindTools: () => {
              bindToolsCalls += 1;
              return {
                invoke: async () => ({
                  content: "",
                  tool_calls: [{ name: "result", args: { ok: true } }],
                }),
              };
            },
          }) as unknown as LangChainChatModelLike,
      },
    }),
  );

  const result = await gateway.chat.complete({
    model: "chat-default",
    messages: [{ role: "user", content: "hi" }],
    thinking: { mode: "auto" },
    structuredOutput: {
      name: "result",
      schema: { type: "object", properties: {} },
    },
  });

  // The model factory saw the translated payload: "auto" became "off".
  assert.deepEqual(seenThinkingModes, ["off"]);
  // Hard-disable adapter (deepseek) + thinking now off → the plan upgrades to
  // the forced withStructuredOutput strategy; the available-tool fallback is
  // not used.
  assert.equal(structuredCalls, 1);
  assert.equal(bindToolsCalls, 0);
  assert.deepEqual(result.structuredOutput, { ok: true });
});

test("structured output with an explicit effort request keeps thinking and the available-tool strategy", async () => {
  let structuredCalls = 0;
  let bindToolsCalls = 0;
  const gateway = createModelGateway(
    chainConfig({
      providerKind: "deepseek",
      targets: [{ provider: "ds", model: "deepseek-v4-pro" }],
      modelCapabilities: [
        {
          modelMatch: "deepseek-v4-pro",
          capabilities: { forcedToolChoiceBlockedByThinking: true },
        },
      ],
      models: {
        ds: () =>
          ({
            getName: () => "ds",
            withStructuredOutput: () => {
              structuredCalls += 1;
              return {
                invoke: async () => ({
                  raw: { content: "{}" },
                  parsed: { ok: true },
                }),
              };
            },
            bindTools: () => {
              bindToolsCalls += 1;
              return {
                invoke: async () => ({
                  content: "",
                  tool_calls: [{ name: "result", args: { ok: true } }],
                }),
              };
            },
          }) as unknown as LangChainChatModelLike,
      },
    }),
  );

  const result = await gateway.chat.complete({
    model: "chat-default",
    messages: [{ role: "user", content: "hi" }],
    thinking: { mode: "effort", effort: "high" },
    structuredOutput: {
      name: "result",
      schema: { type: "object", properties: {} },
    },
  });

  // The caller explicitly asked for thinking: no translation, forced
  // tool_choice stays blocked, the schema rides as an available tool.
  assert.equal(bindToolsCalls, 1);
  assert.equal(structuredCalls, 0);
  assert.deepEqual(result.structuredOutput, { ok: true });
});

// The exact damage class DeepSeek V4 produces: raw ASCII quotes inside a
// Chinese string value — invalid JSON that LangChain's strict parser files
// under invalid_tool_calls.
const BROKEN_ARGS =
  '{"summary": "它其实没有"表面"，只有一道边界。", "ok": true}';

test("same canonical model through different gateways is skipped on structured-output failure", async () => {
  const calls: string[] = [];
  const gateway = createModelGateway(
    chainConfig({
      targets: [
        { provider: "primary", model: "deepseek-v4-pro" },
        { provider: "backup", model: "deepseek/deepseek-v4-pro" },
      ],
      models: {
        primary: emptyStructuredModel(calls, "primary"),
        backup: emptyStructuredModel(calls, "backup"),
      },
    }),
  );

  await assert.rejects(
    gateway.chat.complete({
      model: "chat-default",
      messages: [{ role: "user", content: "hi" }],
      structuredOutput: {
        name: "result",
        schema: { type: "object", properties: {} },
      },
    }),
    (error: { code?: string }) => error.code === "STRUCTURED_OUTPUT",
  );
  // "deepseek-v4-pro" and "deepseek/deepseek-v4-pro" are the same model with
  // different gateway prefixes — the prefix must not defeat the skip.
  assert.deepEqual(calls, ["primary"]);
});

function brokenArgsStructuredModel(): LangChainChatModelLike {
  return {
    getName: () => "primary",
    withStructuredOutput: () => ({
      invoke: async () => ({
        raw: {
          content: "",
          tool_calls: [],
          invalid_tool_calls: [
            {
              name: "result",
              args: BROKEN_ARGS,
              error: "not valid JSON",
              type: "invalid_tool_call",
            },
          ],
          response_metadata: { finish_reason: "tool_calls" },
        },
        parsed: null,
      }),
    }),
  } as unknown as LangChainChatModelLike;
}

test("withStructuredOutput path repairs invalid argument JSON when the model DB declares the quirk", async () => {
  const gateway = createModelGateway(
    chainConfig({
      targets: [{ provider: "primary", model: "primary-model" }],
      modelCapabilities: [
        {
          modelMatch: "primary-model",
          capabilities: { toolCallArgumentJsonRepair: true },
        },
      ],
      models: { primary: brokenArgsStructuredModel },
    }),
  );

  const result = await gateway.chat.complete({
    model: "chat-default",
    messages: [{ role: "user", content: "hi" }],
    structuredOutput: {
      name: "result",
      schema: { type: "object", properties: {} },
    },
  });

  assert.deepEqual(result.structuredOutput, {
    summary: "它其实没有\"表面\"，只有一道边界。",
    ok: true,
  });
});

test("without the declared quirk, invalid argument JSON still fails loudly", async () => {
  const gateway = createModelGateway(
    chainConfig({
      targets: [{ provider: "primary", model: "primary-model" }],
      models: { primary: brokenArgsStructuredModel },
    }),
  );

  await assert.rejects(
    gateway.chat.complete({
      model: "chat-default",
      messages: [{ role: "user", content: "hi" }],
      structuredOutput: {
        name: "result",
        schema: { type: "object", properties: {} },
      },
    }),
    (error: { code?: string }) => error.code === "STRUCTURED_OUTPUT",
  );
});

test("a valid-but-unlifted tool call is salvaged losslessly for any model", async () => {
  const gateway = createModelGateway(
    chainConfig({
      targets: [{ provider: "primary", model: "primary-model" }],
      models: {
        primary: () =>
          ({
            getName: () => "primary",
            withStructuredOutput: () => ({
              invoke: async () => ({
                raw: {
                  content: "",
                  tool_calls: [],
                  additional_kwargs: {
                    tool_calls: [
                      {
                        id: "call_1",
                        type: "function",
                        function: {
                          name: "result",
                          arguments: '{"ok": true}',
                        },
                      },
                    ],
                  },
                },
                parsed: null,
              }),
            }),
          }) as unknown as LangChainChatModelLike,
      },
    }),
  );

  const result = await gateway.chat.complete({
    model: "chat-default",
    messages: [{ role: "user", content: "hi" }],
    structuredOutput: {
      name: "result",
      schema: { type: "object", properties: {} },
    },
  });

  assert.deepEqual(result.structuredOutput, { ok: true });
});

test("available-tool path salvages arguments from the raw wire kwargs", async () => {
  const gateway = createModelGateway(
    chainConfig({
      providerKind: "deepseek",
      targets: [{ provider: "ds", model: "deepseek-v4-pro" }],
      modelCapabilities: [
        {
          modelMatch: "deepseek-v4-pro",
          capabilities: {
            forcedToolChoiceBlockedByThinking: true,
            toolCallArgumentJsonRepair: true,
          },
        },
      ],
      models: {
        ds: () =>
          ({
            getName: () => "ds",
            bindTools: () => ({
              invoke: async () => ({
                content: "",
                tool_calls: [],
                additional_kwargs: {
                  tool_calls: [
                    {
                      id: "call_1",
                      type: "function",
                      function: { name: "result", arguments: BROKEN_ARGS },
                    },
                  ],
                },
              }),
            }),
          }) as unknown as LangChainChatModelLike,
      },
    }),
  );

  const result = await gateway.chat.complete({
    model: "chat-default",
    messages: [{ role: "user", content: "hi" }],
    // Explicit effort keeps thinking on → availableTool strategy.
    thinking: { mode: "effort", effort: "high" },
    structuredOutput: {
      name: "result",
      schema: { type: "object", properties: {} },
    },
  });

  assert.equal(
    (result.structuredOutput as { ok?: boolean } | undefined)?.ok,
    true,
  );
});

test("chat.stream: terminal administrative error is out-ranked by an earlier substantive failure", async () => {
  const gateway = createModelGateway(
    chainConfig({
      targets: [
        { provider: "primary", model: "primary-model" },
        { provider: "backup", model: "backup-model" },
      ],
      models: {
        primary: () =>
          ({
            getName: () => "primary",
            stream: async () => {
              throw httpError(500, "upstream exploded");
            },
          }) as unknown as LangChainChatModelLike,
        backup: () =>
          ({
            getName: () => "backup",
            stream: async () => {
              throw httpError(402, "402 status code (no body)");
            },
          }) as unknown as LangChainChatModelLike,
      },
    }),
  );

  const events: ChatStreamEvent[] = [];
  for await (const event of gateway.chat.stream({
    model: "chat-default",
    messages: [{ role: "user", content: "hi" }],
  })) {
    events.push(event);
  }

  const terminal = events.at(-1);
  assert.equal(terminal?.type, "error");
  assert.equal(
    terminal?.type === "error" ? terminal.error.code : undefined,
    "UPSTREAM",
  );
});
