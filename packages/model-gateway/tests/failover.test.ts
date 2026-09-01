import assert from "node:assert/strict";
import test from "node:test";
import {
  createLangChainChatModel,
  createModelGateway,
  resolveModelGatewayConfig,
  resolveRequestCandidates,
  TargetHealthRegistry,
} from "../src/index";
import type {
  ChatStreamEvent,
  LangChainChatModelLike,
  ModelGatewayConfig,
} from "../src/types";

function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

/**
 * Two-provider gateway config where the fake model per provider is supplied by
 * the test. Route strategy is priority: 'primary' first, 'backup' second.
 */
function twoTargetConfig(
  modelsByProvider: Record<string, () => LangChainChatModelLike>,
  targetHealth: TargetHealthRegistry = new TargetHealthRegistry(),
): ModelGatewayConfig {
  return {
    baseUrl: "https://gateway.example.com",
    allowedModelAliases: ["chat-default"],
    // Isolated per test: the process-wide default registry would leak one
    // test's cooldowns into the next (same provider/model keys).
    targetHealth,
    providers: {
      primary: {
        kind: "openai",
        baseUrl: "https://primary.example.com/v1",
        apiKey: "primary-key",
      },
      backup: {
        kind: "openai",
        baseUrl: "https://backup.example.com/v1",
        apiKey: "backup-key",
      },
    },
    modelRoutes: {
      "chat-default": {
        strategy: "priority",
        targets: [
          { provider: "primary", model: "primary-model", priority: 1 },
          { provider: "backup", model: "backup-model", priority: 2 },
        ],
      },
    },
    langchainFactories: {
      createChatModel: ({ target }) => modelsByProvider[target.provider]!(),
    },
  };
}

function stubModel(input: {
  invoke?: () => Promise<Record<string, unknown>>;
  stream?: () => Promise<AsyncIterable<Record<string, unknown>>>;
}): LangChainChatModelLike {
  return {
    getName: () => "stub",
    invoke: async () => {
      if (!input.invoke) {
        throw new Error("invoke not stubbed");
      }
      return input.invoke();
    },
    stream: async () => {
      if (!input.stream) {
        throw new Error("stream not stubbed");
      }
      return input.stream();
    },
  };
}

test("chat.complete fails over to the next target on quota exhaustion", async () => {
  const calls: string[] = [];
  const gateway = createModelGateway(
    twoTargetConfig({
      primary: () =>
        stubModel({
          invoke: async () => {
            calls.push("primary");
            throw httpError(402, "Insufficient credits");
          },
        }),
      backup: () =>
        stubModel({
          invoke: async () => {
            calls.push("backup");
            return { id: "msg_1", content: "rescued" };
          },
        }),
    }),
  );

  const result = await gateway.chat.complete({
    model: "chat-default",
    messages: [{ role: "user", content: "hi" }],
  });

  assert.deepEqual(calls, ["primary", "backup"]);
  assert.equal(result.raw.content, "rescued");
  assert.equal(result.provider, "backup");
  assert.equal(result.providerModel, "backup-model");
});

test("chat.complete fallbackPolicy none executes exactly one configured target", async () => {
  const calls: string[] = [];
  const gateway = createModelGateway(
    twoTargetConfig({
      primary: () =>
        stubModel({
          invoke: async () => {
            calls.push("primary");
            throw httpError(402, "Insufficient credits");
          },
        }),
      backup: () =>
        stubModel({
          invoke: async () => {
            calls.push("backup");
            return { content: "must not run" };
          },
        }),
    }),
  );

  await assert.rejects(
    gateway.chat.complete({
      model: "chat-default",
      messages: [{ role: "user", content: "hi" }],
      fallbackPolicy: "none",
    }),
    (error: { code?: string }) => error.code === "QUOTA",
  );
  assert.deepEqual(calls, ["primary"]);
});

test("chat.complete does not fail over on a bad request", async () => {
  const calls: string[] = [];
  const gateway = createModelGateway(
    twoTargetConfig({
      primary: () =>
        stubModel({
          invoke: async () => {
            calls.push("primary");
            throw httpError(400, "Invalid request payload");
          },
        }),
      backup: () =>
        stubModel({
          invoke: async () => {
            calls.push("backup");
            return { content: "should never run" };
          },
        }),
    }),
  );

  await assert.rejects(
    gateway.chat.complete({
      model: "chat-default",
      messages: [{ role: "user", content: "hi" }],
    }),
    (error: { code?: string }) => error.code === "BAD_REQUEST",
  );
  // A request-shaped failure fails everywhere; the backup must not burn a
  // wasted attempt.
  assert.deepEqual(calls, ["primary"]);
});

test("chat.stream fails over when the primary dies before the first chunk", async () => {
  const calls: string[] = [];
  const gateway = createModelGateway(
    twoTargetConfig({
      primary: () =>
        stubModel({
          stream: async () => {
            calls.push("primary");
            throw httpError(402, "Insufficient credits");
          },
        }),
      backup: () =>
        stubModel({
          stream: async () => {
            calls.push("backup");
            return (async function* () {
              yield { content: "res" };
              yield { content: "cued" };
            })();
          },
        }),
    }),
  );

  const events: ChatStreamEvent[] = [];
  for await (const event of gateway.chat.stream({
    model: "chat-default",
    messages: [{ role: "user", content: "hi" }],
  })) {
    events.push(event);
  }

  assert.deepEqual(calls, ["primary", "backup"]);
  // The consumer must never see the primary's failure — only backup's clean
  // stream: its chunks and terminal metadata.
  assert.equal(events.some((event) => event.type === "error"), false);
  const chunks = events.filter((event) => event.type === "chunk");
  assert.equal(chunks.length, 2);
  assert.equal(events.at(-1)?.type, "metadata");
});

test("chat.stream fallbackPolicy none surfaces the first target error", async () => {
  const calls: string[] = [];
  const gateway = createModelGateway(
    twoTargetConfig({
      primary: () =>
        stubModel({
          stream: async () => {
            calls.push("primary");
            throw httpError(402, "Insufficient credits");
          },
        }),
      backup: () =>
        stubModel({
          stream: async () => {
            calls.push("backup");
            return (async function* () {
              yield { content: "must not run" };
            })();
          },
        }),
    }),
  );

  const events: ChatStreamEvent[] = [];
  for await (const event of gateway.chat.stream({
    model: "chat-default",
    messages: [{ role: "user", content: "hi" }],
    fallbackPolicy: "none",
  })) {
    events.push(event);
  }

  assert.deepEqual(calls, ["primary"]);
  assert.equal(events.at(-1)?.type, "error");
});

test("chat.stream does not fail over after output reached the consumer", async () => {
  const calls: string[] = [];
  const gateway = createModelGateway(
    twoTargetConfig({
      primary: () =>
        stubModel({
          stream: async () => {
            calls.push("primary");
            return (async function* () {
              yield { content: "half an ans" };
              throw httpError(502, "Upstream died mid-stream");
            })();
          },
        }),
      backup: () =>
        stubModel({
          stream: async () => {
            calls.push("backup");
            return (async function* () {
              yield { content: "should never run" };
            })();
          },
        }),
    }),
  );

  const events: ChatStreamEvent[] = [];
  for await (const event of gateway.chat.stream({
    model: "chat-default",
    messages: [{ role: "user", content: "hi" }],
  })) {
    events.push(event);
  }

  // Half an answer is committed: the stream surfaces the failure instead of
  // replaying the request elsewhere.
  assert.deepEqual(calls, ["primary"]);
  assert.equal(events[0]?.type, "chunk");
  assert.equal(events.at(-1)?.type, "error");
});

test("LangChain chat model facade fails over invoke and keeps bound tools", async () => {
  const calls: string[] = [];
  const boundTools: Record<string, unknown[]> = {};
  const makeModel = (name: string): LangChainChatModelLike => ({
    getName: () => name,
    bindTools(tools) {
      boundTools[name] = tools;
      return this;
    },
    invoke: async () => {
      calls.push(name);
      if (name === "primary") {
        throw httpError(402, "Insufficient credits");
      }
      return { content: "rescued" };
    },
    stream: async () => (async function* () {})(),
  });

  const model = await createLangChainChatModel({
    modelAlias: "chat-default",
    config: twoTargetConfig({
      primary: () => makeModel("primary"),
      backup: () => makeModel("backup"),
    }),
  });

  const bound = (model as unknown as LangChainChatModelLike).bindTools!([
    { name: "lookup" },
  ]);
  const result = (await bound.invoke([{ role: "user", content: "hi" }])) as {
    content: string;
  };

  assert.equal(result.content, "rescued");
  assert.deepEqual(calls, ["primary", "backup"]);
  // The fallback model must carry the same tools as the model it replaced.
  assert.equal(boundTools.primary?.length, 1);
  assert.equal(boundTools.backup?.length, 1);
});

test("LangChain chat model fallbackPolicy none binds only the selected target", async () => {
  const calls: string[] = [];
  const model = await createLangChainChatModel({
    modelAlias: "chat-default",
    config: twoTargetConfig({
      primary: () =>
        stubModel({
          invoke: async () => {
            calls.push("primary");
            throw httpError(402, "Insufficient credits");
          },
        }),
      backup: () =>
        stubModel({
          invoke: async () => {
            calls.push("backup");
            return { content: "must not run" };
          },
        }),
    }),
    execution: { fallbackPolicy: "none" },
  });

  await assert.rejects(
    model.invoke([{ role: "user", content: "hi" }]),
    (error: Error) => error.message === "Insufficient credits",
  );
  assert.deepEqual(calls, ["primary"]);
});

test("resolveRequestCandidates orders priority targets and keeps zero-weight targets as failover tail", async () => {
  const resolved = resolveModelGatewayConfig({
    baseUrl: "https://gateway.example.com",
    fetch: async () => new Response("{}"),
    providers: {
      a: { kind: "openai-compatible", baseUrl: "https://a.example.com/v1", apiKey: "a" },
      b: { kind: "openai-compatible", baseUrl: "https://b.example.com/v1", apiKey: "b" },
    },
    modelRoutes: {
      "chat-default": {
        strategy: "weighted-random",
        targets: [
          { provider: "a", model: "model-a", priority: 1, weight: 100 },
          { provider: "b", model: "model-b", priority: 2, weight: 0 },
        ],
      },
    },
  });

  // Weight 0 means "never selected while a weighted target remains" — with a
  // single positive weight the order is fully deterministic.
  const candidates = await resolveRequestCandidates(resolved, {
    model: "chat-default",
  });
  assert.deepEqual(
    candidates.map((candidate) => candidate.provider),
    ["a", "b"],
  );
});

test("a failed target is demoted so the next request skips its dead round-trip", async () => {
  const calls: string[] = [];
  const gateway = createModelGateway(
    twoTargetConfig({
      primary: () =>
        stubModel({
          invoke: async () => {
            calls.push("primary");
            throw httpError(402, "Insufficient credits");
          },
        }),
      backup: () =>
        stubModel({
          invoke: async () => {
            calls.push("backup");
            return { content: "ok" };
          },
        }),
    }),
  );
  const request = () =>
    gateway.chat.complete({
      model: "chat-default",
      messages: [{ role: "user", content: "hi" }],
    });

  await request(); // pays the failed primary round-trip once
  await request(); // primary is cooling down -> straight to backup

  assert.deepEqual(calls, ["primary", "backup", "backup"]);
});

test("an expired cooldown re-probes the demoted target", async () => {
  let nowMs = 0;
  const registry = new TargetHealthRegistry({
    baseCooldownMs: 10_000,
    now: () => nowMs,
  });
  const calls: string[] = [];
  const gateway = createModelGateway(
    twoTargetConfig(
      {
        primary: () =>
          stubModel({
            invoke: async () => {
              calls.push("primary");
              throw httpError(402, "Insufficient credits");
            },
          }),
        backup: () =>
          stubModel({
            invoke: async () => {
              calls.push("backup");
              return { content: "ok" };
            },
          }),
      },
      registry,
    ),
  );
  const request = () =>
    gateway.chat.complete({
      model: "chat-default",
      messages: [{ role: "user", content: "hi" }],
    });

  await request(); // primary fails -> cooling for 10s
  nowMs = 5_000;
  await request(); // still cooling -> backup only
  nowMs = 15_000;
  await request(); // window expired -> primary probed again, fails, cools again

  assert.deepEqual(calls, [
    "primary",
    "backup",
    "backup",
    "primary",
    "backup",
  ]);
});

test("with every target cooling down the full chain still serves requests", async () => {
  const behavior = { primaryFails: true, backupFails: true };
  const calls: string[] = [];
  const gateway = createModelGateway(
    twoTargetConfig({
      primary: () =>
        stubModel({
          invoke: async () => {
            calls.push("primary");
            if (behavior.primaryFails) {
              throw httpError(402, "Insufficient credits");
            }
            return { content: "primary recovered" };
          },
        }),
      backup: () =>
        stubModel({
          invoke: async () => {
            calls.push("backup");
            if (behavior.backupFails) {
              throw httpError(502, "Backup down too");
            }
            return { content: "ok" };
          },
        }),
    }),
  );
  const request = () =>
    gateway.chat.complete({
      model: "chat-default",
      messages: [{ role: "user", content: "hi" }],
    });

  // Both targets fail: the request errors and both enter cooldown.
  await assert.rejects(request);
  assert.deepEqual(calls, ["primary", "backup"]);

  // Everything cooling must degrade to the original order, not to an empty
  // list — the next request still goes out and reaches a recovered primary.
  behavior.primaryFails = false;
  const result = await request();
  assert.equal(result.raw.content, "primary recovered");
  assert.deepEqual(calls, ["primary", "backup", "primary"]);
});

test("cooldown escalates on consecutive failures and resets on success", () => {
  let nowMs = 0;
  const registry = new TargetHealthRegistry({
    baseCooldownMs: 10_000,
    maxCooldownMs: 60_000,
    now: () => nowMs,
  });
  const target = {
    provider: "primary",
    baseUrl: "https://primary.example.com/v1",
    providerModel: "primary-model",
  };

  registry.markFailure(target); // 10s window
  nowMs = 9_999;
  assert.equal(registry.isCoolingDown(target), true);
  nowMs = 10_001;
  assert.equal(registry.isCoolingDown(target), false);

  registry.markFailure(target); // second consecutive -> 20s window
  nowMs = 10_001 + 19_000;
  assert.equal(registry.isCoolingDown(target), true);

  registry.markSuccess(target); // reset
  assert.equal(registry.isCoolingDown(target), false);
  registry.markFailure(target); // back to the 10s base window
  nowMs += 10_001;
  assert.equal(registry.isCoolingDown(target), false);
});

test("BYOK resolves to exactly one candidate", async () => {
  const resolved = resolveModelGatewayConfig({
    baseUrl: "https://gateway.example.com",
    fetch: async () => new Response("{}"),
    modeDefault: "GLOBAL",
    byokProviderAllowList: ["openrouter"],
    providers: {
      // The gateway auto-creates default routes against a provider named
      // "default"; it must exist for the config to resolve.
      default: {
        kind: "openai-compatible",
        baseUrl: "https://default.example.com/v1",
        apiKey: "default-key",
      },
      openrouter: {
        kind: "openai-compatible",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "global-key",
      },
    },
  });

  const candidates = await resolveRequestCandidates(resolved, {
    model: "some/model",
    executionMode: "BYOK",
    providerHint: "openrouter",
    byok: { provider: "openrouter", apiKey: "user-key" },
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.apiKey, "user-key");
});
