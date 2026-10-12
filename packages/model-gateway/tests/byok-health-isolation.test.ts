import assert from "node:assert/strict";
import test from "node:test";
import {
  createLangChainChatModel,
  createModelGateway,
  TargetHealthRegistry,
} from "../src/index";
import type { ModelGatewayConfig } from "../src/types";

const paths = ["complete", "stream", "langchain-invoke", "langchain-stream"] as const;
type CallPath = (typeof paths)[number];

function fixture() {
  const calls: string[] = [];
  const failures = new Map<string, number>();
  const config: ModelGatewayConfig = {
    targetHealth: new TargetHealthRegistry({ now: () => 0 }),
    providers: {
      primary: {
        kind: "openai",
        baseUrl: "https://primary.example.com/v1",
        apiKey: "global-key",
      },
      backup: {
        kind: "openai",
        baseUrl: "https://backup.example.com/v1",
        apiKey: "backup-key",
      },
    },
    modelRoutes: {
      "chat-default": {
        targets: [
          { provider: "primary", model: "shared-model", priority: 1 },
          { provider: "backup", model: "backup-model", priority: 2 },
        ],
      },
    },
    langchainFactories: {
      createChatModel: ({ target }) => {
        const reply = () => {
          const account = `${target.routeDecision.mode}:${target.provider}`;
          calls.push(account);
          assert.equal(target.apiKey, target.routeDecision.mode === "BYOK"
            ? "user-key"
            : target.provider === "primary" ? "global-key" : "backup-key");
          const status = failures.get(account);
          if (status) throw Object.assign(new Error("account rejected"), { status });
          return { content: "ok" };
        };
        return {
          getName: () => "health-isolation-stub",
          invoke: async () => reply(),
          stream: async () => (async function* () { yield reply(); })(),
        };
      },
    },
  };
  const gateway = createModelGateway(config);
  const global = () => gateway.chat.complete({
    model: "chat-default",
    messages: [{ role: "user", content: "hello" }],
  });
  const byok = async (path: CallPath) => {
    const execution = {
      executionMode: "BYOK" as const,
      // A user selects the existing System Provider and supplies their own key.
      byok: { provider: "primary", apiKey: "user-key" },
    };
    if (path === "complete" || path === "stream") {
      const input = {
        ...execution,
        model: "shared-model",
        messages: [{ role: "user" as const, content: "hello" }],
      };
      if (path === "complete") return gateway.chat.complete(input);
      for await (const event of gateway.chat.stream(input)) {
        if (event.type === "error") throw new Error(event.error.message);
      }
      return;
    }
    const model = await createLangChainChatModel({
      config, modelAlias: "shared-model", execution,
    });
    if (path === "langchain-invoke") return model.invoke("hello");
    for await (const _chunk of await model.stream("hello")) { /* drain */ }
  };
  return { calls, failures, global, byok };
}

for (const path of paths) {
  for (const status of [401, 402]) {
    test(`${path}: BYOK ${status} cannot demote a healthy GLOBAL account`, async () => {
      const f = fixture();
      f.failures.set("BYOK:primary", status);
      await assert.rejects(f.byok(path));
      const result = await f.global();
      assert.equal(result.provider, "primary");
      assert.deepEqual(f.calls, ["BYOK:primary", "GLOBAL:primary"]);
    });
  }

  test(`${path}: BYOK success cannot clear a GLOBAL account cooldown`, async () => {
    const f = fixture();
    f.failures.set("GLOBAL:primary", 401);
    assert.equal((await f.global()).provider, "backup");
    await f.byok(path);
    assert.equal((await f.global()).provider, "backup");
    // The last GLOBAL request must not retry the known-bad global credential.
    assert.deepEqual(f.calls, [
      "GLOBAL:primary", "GLOBAL:backup", "BYOK:primary", "GLOBAL:backup",
    ]);
  });
}
