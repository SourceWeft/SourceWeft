/**
 * One failover policy, every path: each case below runs unchanged against the
 * gateway's non-stream `chat.complete`, the gateway `chat.stream`, and the
 * LangChain facade the agent runs on (`invoke` and `stream`). A rule that
 * holds on one path and not another fails here.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  createLangChainChatModel,
  createModelGateway,
  ModelGatewayError,
  normalizeGatewayError,
  TargetHealthRegistry,
} from "../src/index";
import type {
  LangChainChatModelLike,
  ModelGatewayConfig,
  RouteAttempt,
} from "../src/types";

type Behavior =
  { fail: () => unknown; beforeFail?: () => void } | { reply: string };

type Target = { provider: string; model: string };

type LogEntry = { event: string; fields: Record<string, unknown> };

type Harness = {
  calls: string[];
  logs: LogEntry[];
  /** `routeDecision.attempt` of every generation that started, in order. */
  attempts: Array<RouteAttempt | undefined>;
  config: ModelGatewayConfig;
};

const TWO: Target[] = [
  { provider: "primary", model: "primary-model" },
  { provider: "backup", model: "backup-model" },
];

function httpError(status: number, message = `HTTP ${status}`) {
  return Object.assign(new Error(message), { status });
}

function harness(
  targets: Target[],
  behaviors: Record<string, Behavior>,
  targetHealth = new TargetHealthRegistry(),
): Harness {
  const calls: string[] = [];
  const logs: LogEntry[] = [];
  const attempts: Array<RouteAttempt | undefined> = [];
  const run = async (provider: string) => {
    calls.push(provider);
    const behavior = behaviors[provider]!;
    if ("fail" in behavior) {
      behavior.beforeFail?.();
      throw behavior.fail();
    }
    return behavior.reply;
  };
  const model = (provider: string): LangChainChatModelLike => ({
    getName: () => provider,
    invoke: async () => ({ content: await run(provider) }),
    stream: async () => {
      const reply = await run(provider);
      return (async function* () {
        yield { content: reply };
      })();
    },
  });
  const providers: ModelGatewayConfig["providers"] = {};
  for (const target of targets) {
    providers[target.provider] = {
      kind: "openai",
      baseUrl: `https://${target.provider}.example.com/v1`,
      apiKey: `${target.provider}-key`,
    };
  }
  return {
    calls,
    logs,
    attempts,
    config: {
      baseUrl: "https://gateway.example.com",
      allowedModelAliases: ["chat-default"],
      targetHealth,
      providers,
      modelRoutes: {
        "chat-default": {
          strategy: "priority",
          targets: targets.map((target, index) => ({
            provider: target.provider,
            model: target.model,
            priority: index + 1,
          })),
        },
      },
      langchainFactories: {
        createChatModel: ({ target }) => model(target.provider),
      },
      logger: {
        warn: (event, fields) => logs.push({ event, fields: fields ?? {} }),
      },
      observeSink: {
        onGenerationStart(event) {
          attempts.push(event.routeDecision?.attempt);
        },
      },
    },
  };
}

type Outcome = { reply?: string; errorCode?: string };

type Driver = {
  name: string;
  /** The `operation` its failover logs carry. */
  operation: "chat.complete" | "chat.stream";
  run: (
    config: ModelGatewayConfig,
    signal?: AbortSignal,
    fallbackPolicy?: "none",
  ) => Promise<Outcome>;
};

const messages = [{ role: "user" as const, content: "hi" }];

/** The LangChain facade hands raw provider errors on; compare their codes. */
function codeOf(error: unknown) {
  return normalizeGatewayError(error).code;
}

const DRIVERS: Driver[] = [
  {
    name: "gateway chat.complete",
    operation: "chat.complete",
    run: async (config, signal, fallbackPolicy) => {
      try {
        const result = await createModelGateway(config).chat.complete(
          { model: "chat-default", messages, fallbackPolicy },
          { signal },
        );
        return { reply: String(result.raw.content) };
      } catch (error) {
        return { errorCode: codeOf(error) };
      }
    },
  },
  {
    name: "gateway chat.stream",
    operation: "chat.stream",
    run: async (config, signal, fallbackPolicy) => {
      let reply = "";
      try {
        for await (const event of createModelGateway(config).chat.stream(
          { model: "chat-default", messages, fallbackPolicy },
          { signal },
        )) {
          if (event.type === "error") return { errorCode: event.error.code };
          if (event.type === "chunk") reply += event.chunk.content ?? "";
        }
      } catch (error) {
        return { errorCode: codeOf(error) };
      }
      return { reply };
    },
  },
  {
    name: "LangChain invoke",
    operation: "chat.complete",
    run: async (config, signal, fallbackPolicy) => {
      const model = (await createLangChainChatModel({
        modelAlias: "chat-default",
        config,
        execution: { fallbackPolicy },
      })) as unknown as LangChainChatModelLike;
      try {
        const result = (await model.invoke(messages, { signal })) as {
          content: string;
        };
        return { reply: result.content };
      } catch (error) {
        return { errorCode: codeOf(error) };
      }
    },
  },
  {
    name: "LangChain stream",
    operation: "chat.stream",
    run: async (config, signal, fallbackPolicy) => {
      const model = (await createLangChainChatModel({
        modelAlias: "chat-default",
        config,
        execution: { fallbackPolicy },
      })) as unknown as LangChainChatModelLike;
      let reply = "";
      try {
        for await (const chunk of await model.stream(messages, { signal })) {
          reply += String((chunk as { content?: unknown }).content ?? "");
        }
      } catch (error) {
        return { errorCode: codeOf(error) };
      }
      return { reply };
    },
  },
];

function eventsNamed(logs: LogEntry[], event: string) {
  return logs.filter((entry) => entry.event === event).map((e) => e.fields);
}

for (const driver of DRIVERS) {
  for (const [status, code] of [
    [429, "RATE_LIMIT"],
    [402, "QUOTA"],
    [401, "AUTH"],
  ] as const) {
    test(`${driver.name}: a ${status} fails over, logs it and records the attempt`, async () => {
      const h = harness(TWO, {
        primary: { fail: () => httpError(status) },
        backup: { reply: "rescued" },
      });

      const outcome = await driver.run(h.config);

      assert.deepEqual(outcome, { reply: "rescued" });
      assert.deepEqual(h.calls, ["primary", "backup"]);
      assert.deepEqual(eventsNamed(h.logs, "model-gateway.failover"), [
        {
          operation: driver.operation,
          alias: "chat-default",
          failedProvider: "primary",
          failedProviderModel: "primary-model",
          errorCode: code,
          nextProvider: "backup",
          attempt: 1,
          candidates: 2,
        },
      ]);
      assert.deepEqual(h.attempts, [
        { index: 1, of: 2, primaryProvider: "primary" },
        {
          index: 2,
          of: 2,
          primaryProvider: "primary",
          failoverFrom: [
            {
              provider: "primary",
              providerModel: "primary-model",
              errorCode: code,
            },
          ],
        },
      ]);
    });
  }

  test(`${driver.name}: a bad request does not fail over`, async () => {
    const h = harness(TWO, {
      primary: { fail: () => httpError(400) },
      backup: { reply: "must not run" },
    });

    const outcome = await driver.run(h.config);

    assert.equal(outcome.errorCode, "BAD_REQUEST");
    assert.deepEqual(h.calls, ["primary"]);
    assert.deepEqual(eventsNamed(h.logs, "model-gateway.failover"), []);
  });

  test(`${driver.name}: a structured-output failure skips the same model`, async () => {
    const h = harness(
      [
        { provider: "direct", model: "acme-1" },
        { provider: "router", model: "acme/acme-1" },
        { provider: "other", model: "other-1" },
      ],
      {
        direct: {
          fail: () =>
            new ModelGatewayError({
              code: "STRUCTURED_OUTPUT",
              message: "no valid answer",
            }),
        },
        router: { reply: "must not run" },
        other: { reply: "different model" },
      },
    );

    const outcome = await driver.run(h.config);

    assert.deepEqual(outcome, { reply: "different model" });
    assert.deepEqual(h.calls, ["direct", "other"]);
    const [failover] = eventsNamed(h.logs, "model-gateway.failover");
    assert.equal(failover?.nextProvider, "other");
    assert.equal(failover?.skippedSameModelCandidates, 1);
  });

  test(`${driver.name}: a caller abort is never replayed on another target`, async () => {
    const controller = new AbortController();
    const h = harness(TWO, {
      primary: {
        beforeFail: () => controller.abort(),
        fail: () => httpError(429),
      },
      backup: { reply: "must not run" },
    });

    const outcome = await driver.run(h.config, controller.signal);

    assert.equal(outcome.reply, undefined);
    assert.deepEqual(h.calls, ["primary"]);
    assert.deepEqual(eventsNamed(h.logs, "model-gateway.failover"), []);
  });

  test(`${driver.name}: an exhausted chain surfaces the most informative error`, async () => {
    const h = harness(TWO, {
      primary: { fail: () => httpError(429) },
      backup: { fail: () => httpError(402) },
    });

    const outcome = await driver.run(h.config);

    // The unfunded tail target must not mask the primary's rate limit.
    assert.equal(outcome.errorCode, "RATE_LIMIT");
    assert.deepEqual(h.calls, ["primary", "backup"]);
    const [exhausted] = eventsNamed(h.logs, "model-gateway.failover-exhausted");
    assert.deepEqual(
      { ...exhausted, targetErrors: undefined },
      {
        operation: driver.operation,
        alias: "chat-default",
        surfacedErrorCode: "RATE_LIMIT",
        targetErrors: undefined,
      },
    );
    assert.deepEqual(
      (exhausted?.targetErrors as Array<{ code: string }>).map(
        (entry) => entry.code,
      ),
      ["RATE_LIMIT", "QUOTA"],
    );
  });

  test(`${driver.name}: a cooldown skip is logged and recorded as a fallback`, async () => {
    const health = new TargetHealthRegistry();
    const h = harness(
      TWO,
      {
        primary: { fail: () => httpError(429) },
        backup: { reply: "ok" },
      },
      health,
    );
    await driver.run(h.config); // primary fails once and cools down
    h.calls.length = 0;
    h.logs.length = 0;
    h.attempts.length = 0;

    const outcome = await driver.run(h.config);

    assert.deepEqual(outcome, { reply: "ok" });
    assert.deepEqual(h.calls, ["backup"]);
    assert.deepEqual(eventsNamed(h.logs, "model-gateway.cooldown-skip"), [
      {
        operation: driver.operation,
        alias: "chat-default",
        skipped: [{ provider: "primary", providerModel: "primary-model" }],
        nextProvider: "backup",
        candidates: 2,
      },
    ]);
    assert.deepEqual(h.attempts, [
      {
        index: 1,
        of: 2,
        primaryProvider: "primary",
        cooldownSkipped: [
          { provider: "primary", providerModel: "primary-model" },
        ],
      },
    ]);
  });
}

test("LangChain facade re-reads target health for every call of a turn", async () => {
  const h = harness(TWO, {
    primary: { fail: () => httpError(429) },
    backup: { reply: "ok" },
  });
  const model = (await createLangChainChatModel({
    modelAlias: "chat-default",
    config: h.config,
  })) as unknown as LangChainChatModelLike;

  await model.invoke(messages);
  await model.invoke(messages);

  // The second call of the same model skips the primary that just failed.
  assert.deepEqual(h.calls, ["primary", "backup", "backup"]);
});

for (const driver of DRIVERS) {
  test(`${driver.name}: fallbackPolicy none runs the healthiest target only`, async () => {
    const health = new TargetHealthRegistry();
    const h = harness(
      TWO,
      {
        primary: { fail: () => httpError(429) },
        backup: { reply: "ok" },
      },
      health,
    );
    await driver.run(h.config); // primary fails once and cools down
    h.calls.length = 0;
    h.attempts.length = 0;
    const outcome = await driver.run(h.config, undefined, "none");

    assert.deepEqual(outcome, { reply: "ok" });
    assert.deepEqual(h.calls, ["backup"]);
    assert.deepEqual(h.attempts, [
      {
        index: 1,
        of: 1,
        primaryProvider: "primary",
        cooldownSkipped: [
          { provider: "primary", providerModel: "primary-model" },
        ],
      },
    ]);
  });
}
