import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { AIMessageChunk } from "@langchain/core/messages";
import {
  createLangChainChatModel,
  createModelGateway,
  TargetHealthRegistry,
} from "../src/index";
import { captureProviderResponseFetch } from "../src/observation/response-capture";
import type {
  LangChainChatModelLike,
  ModelGatewayConfig,
  ObserveGenerationEnd,
  ObserveGenerationError,
  ObserveGenerationStart,
} from "../src/types";

type State = {
  starts: ObserveGenerationStart[];
  ends: ObserveGenerationEnd[];
  errors: ObserveGenerationError[];
  warnings: string[];
  closes: number;
  opens: string[];
};
function settings(input: {
  observed: boolean;
  targets: number;
  model: (provider: string, state: State) => LangChainChatModelLike;
}) {
  const state: State = {
    starts: [],
    ends: [],
    errors: [],
    warnings: [],
    closes: 0,
    opens: [],
  };
  const config: ModelGatewayConfig = {
    providers: {
      orcarouter: {
        kind: "openai-compatible",
        baseUrl: "https://primary.invalid/v1",
        apiKey: "test",
      },
      backup: {
        kind: "openai-compatible",
        baseUrl: "https://backup.invalid/v1",
        apiKey: "test",
      },
    },
    modelRoutes: {
      chat: {
        strategy: "priority",
        targets: [
          { provider: "orcarouter", model: "model", priority: 1 },
          ...(input.targets === 2
            ? [{ provider: "backup", model: "backup-model", priority: 2 }]
            : []),
        ],
      },
    },
    timeoutMs: 1000,
    maxRetries: 0,
    targetHealth: new TargetHealthRegistry(),
    logger: { warn: (message) => state.warnings.push(message) },
    observeSink: input.observed
      ? {
          onGenerationStart: (event) => {
            state.starts.push(event);
          },
          onGenerationEnd: (event) => {
            state.ends.push(event);
          },
          onGenerationError: (event) => {
            state.errors.push(event);
          },
        }
      : undefined,
    langchainFactories: {
      createChatModel: ({ target }) => input.model(target.provider, state),
    },
  };
  return { config, state };
}
async function open(
  config: ModelGatewayConfig,
  entry: "endpoint" | "langchain",
  signal?: AbortSignal,
) {
  if (entry === "endpoint")
    return createModelGateway(config)
      .chat.stream(
        { model: "chat", messages: [{ role: "user", content: "hello" }] },
        { signal },
      )
      [Symbol.asyncIterator]();
  const model = (await createLangChainChatModel({
    modelAlias: "chat",
    config,
  })) as unknown as LangChainChatModelLike;
  return (await model.stream("hello", { signal }))[Symbol.asyncIterator]();
}
const partial = () =>
  new AIMessageChunk({
    content: "partial",
    usage_metadata: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
  });
const primaryError = Object.assign(new Error("original request error"), {
  status: 400,
});
const cleanupError = new Error("cleanup error");

for (const entry of ["endpoint", "langchain"] as const) {
  for (const observed of [false, true]) {
    for (const targets of [1, 2]) {
      for (const outcome of [
        "done",
        "return",
        "next-error",
        "return-error",
        "abort",
      ] as const) {
        test(`${entry}, ${targets} target(s), observe=${observed}: ${outcome} closes once and emits one terminal event`, async () => {
          let step = 0;
          const controller = new AbortController();
          const { config, state } = settings({
            observed,
            targets,
            model: (provider, state) => ({
              invoke: async () => {
                throw new Error("unused");
              },
              stream: async () => {
                state.opens.push(provider);
                return {
                  [Symbol.asyncIterator](this: AsyncIterableIterator<unknown>) {
                    return this;
                  },
                  async next() {
                    if (step++ === 0)
                      return { done: false as const, value: partial() };
                    if (outcome === "next-error") throw primaryError;
                    return { done: true as const, value: undefined };
                  },
                  async return() {
                    state.closes++;
                    if (outcome === "return-error" || outcome === "next-error")
                      throw cleanupError;
                    return { done: true as const, value: undefined };
                  },
                };
              },
            }),
          });
          const iterator = await open(config, entry, controller.signal);
          const first = await iterator.next();
          assert.equal(first.done, false);
          if (outcome === "return" || outcome === "return-error") {
            if (outcome === "return-error")
              await assert.rejects(() => iterator.return!(), /cleanup error/);
            else await iterator.return!();
          } else {
            if (outcome === "abort")
              controller.abort(
                new DOMException("caller cancelled", "AbortError"),
              );
            if (
              entry === "langchain" &&
              (outcome === "next-error" || outcome === "abort")
            ) {
              await assert.rejects(
                () => iterator.next(),
                outcome === "next-error"
                  ? /original request error/
                  : /caller cancelled/,
              );
            } else {
              const terminal = await iterator.next();
              if (entry === "endpoint") {
                const event = terminal.value as {
                  type: string;
                  error?: { message: string };
                };
                assert.equal(
                  event.type,
                  outcome === "done" ? "metadata" : "error",
                );
                if (outcome === "next-error")
                  assert.match(event.error!.message, /original request error/);
                await iterator.next();
              } else assert.equal(terminal.done, true);
            }
          }
          await iterator.return!();
          assert.equal(state.closes, 1);
          assert.deepEqual(
            state.opens,
            ["orcarouter"],
            "never replay visible output on a second target",
          );
          assert.equal(state.starts.length, observed ? 1 : 0);
          assert.equal(
            state.ends.length + state.errors.length,
            observed ? 1 : 0,
          );
          if (observed) {
            const terminal = state.ends[0] ?? state.errors[0]!;
            assert.equal(terminal.usage?.totalTokens, 4);
            assert.equal(terminal.observation?.spanId, state.starts[0]!.spanId);
            if (outcome === "return")
              assert.equal(state.errors[0]!.errorCode, "CANCELLED");
            if (outcome === "next-error")
              assert.match(
                state.errors[0]!.errorMessage!,
                /original request error/,
              );
          }
          if (outcome === "next-error")
            assert.ok(
              state.warnings.includes("model-gateway.stream.cleanup.failed"),
            );
        });
      }
    }
  }

  test(`${entry} closes before final capture and settlement, including return-time usage and ALS headers`, async () => {
    for (const cancel of [false, true]) {
      const chunk = partial();
      const capturedFetch = captureProviderResponseFetch(
        async () =>
          new Response(null, {
            headers: {
              "x-orca-request-id": "close-request",
              "x-orca-resolved-model": "close-model",
            },
          }),
      );
      const { config, state } = settings({
        observed: true,
        targets: 1,
        model: () => ({
          invoke: async () => undefined,
          stream: async () => {
            let step = 0;
            return {
              [Symbol.asyncIterator](this: AsyncIterableIterator<unknown>) {
                return this;
              },
              next: async () =>
                step++ === 0
                  ? { done: false as const, value: chunk }
                  : { done: true as const, value: undefined },
              return: async () => {
                await capturedFetch("https://capture.invalid");
                chunk.usage_metadata = {
                  input_tokens: 3,
                  output_tokens: 6,
                  total_tokens: 9,
                };
                state.closes++;
                return { done: true as const, value: undefined };
              },
            };
          },
        }),
      });
      const iterator = await open(config, entry);
      await iterator.next();
      if (cancel) await iterator.return!();
      else
        while (!(await iterator.next()).done) {
          /* drain */
        }
      const terminal = state.ends[0] ?? state.errors[0]!;
      assert.equal(terminal.usage?.totalTokens, 9);
      assert.equal(
        terminal.observation?.identity.providerRequestId,
        "close-request",
      );
      assert.equal(
        terminal.observation?.identity.resolvedProviderModel,
        "close-model",
      );
      assert.equal(state.closes, 1);
    }
  });

  test(`${entry} records SDK stream creation failures and closes each pre-output failover attempt`, async () => {
    const { config, state } = settings({
      observed: true,
      targets: 2,
      model: (provider, state) => ({
        invoke: async () => undefined,
        stream: async () => {
          state.opens.push(provider);
          if (provider === "backup")
            throw Object.assign(new Error("second open failed"), {
              status: 400,
            });
          return {
            [Symbol.asyncIterator](this: AsyncIterableIterator<unknown>) {
              return this;
            },
            next: async () => {
              throw Object.assign(new Error("first read failed"), {
                status: 500,
              });
            },
            return: async () => {
              state.closes++;
              return { done: true as const, value: undefined };
            },
          };
        },
      }),
    });
    const iterator = await open(config, entry);
    if (entry === "langchain") await assert.rejects(() => iterator.next());
    else {
      assert.equal((await iterator.next()).value.type, "error");
      await iterator.next();
    }
    assert.deepEqual(state.opens, ["orcarouter", "backup"]);
    assert.equal(state.closes, 1);
    assert.equal(state.starts.length, 2);
    assert.equal(state.errors.length, 2);
    assert.equal(state.ends.length, 0);
  });

  test(`${entry} closes an SDK iterator that finishes opening after caller cancellation`, async () => {
    let opened!: () => void;
    const opening = new Promise<void>((resolve) => {
      opened = resolve;
    });
    let finishOpening!: () => void;
    const blocked = new Promise<void>((resolve) => {
      finishOpening = resolve;
    });
    const controller = new AbortController();
    const { config, state } = settings({
      observed: true,
      targets: 1,
      model: () => ({
        invoke: async () => undefined,
        stream: async () => {
          opened();
          await blocked;
          return {
            [Symbol.asyncIterator](this: AsyncIterableIterator<unknown>) {
              return this;
            },
            next: async () => ({ done: false as const, value: partial() }),
            return: async () => {
              state.closes++;
              return { done: true as const, value: undefined };
            },
          };
        },
      }),
    });
    const iterator = await open(config, entry, controller.signal);
    const next = iterator.next();
    await opening;
    controller.abort();
    if (entry === "langchain") await assert.rejects(() => next);
    else {
      assert.equal((await next).value.type, "error");
      await iterator.next();
    }
    finishOpening();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(state.closes, 1);
    assert.equal(state.errors.length, 1);
  });
}

for (const entry of ["endpoint", "langchain"] as const) {
  test(
    `${entry}: early return aborts the real OpenAI SDK HTTP response exactly once`,
    { timeout: 5000 },
    async (t) => {
      let cancelled = 0;
      let closed!: () => void;
      const connectionClosed = new Promise<void>((resolve) => {
        closed = resolve;
      });
      const server = createServer((_request, response) => {
        response.on("close", () => {
          cancelled++;
          closed();
        });
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "x-orca-request-id": "real-sdk-close",
        });
        const data = {
          id: "chat-close",
          object: "chat.completion.chunk",
          created: 1,
          model: "model",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "partial" },
              finish_reason: null,
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        };
        response.write(`data: ${JSON.stringify(data)}\n\n`);
      });
      t.after(() => {
        server.closeAllConnections();
        server.close();
      });
      server.listen(0, "127.0.0.1");
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const { config, state } = settings({
        observed: true,
        targets: 2,
        model: () => {
          throw new Error("factory must be disabled");
        },
      });
      config.langchainFactories = undefined;
      config.fetch = globalThis.fetch;
      config.providers!.orcarouter!.baseUrl = `http://127.0.0.1:${address.port}/v1`;
      // Early return must close immediately, without waiting for the request deadline.
      config.timeoutMs = 60_000;
      const iterator = await open(config, entry);
      assert.equal((await iterator.next()).done, false);
      await iterator.return!();
      await connectionClosed;
      assert.equal(cancelled, 1);
      assert.equal(state.starts.length, 1);
      assert.equal(state.errors.length, 1);
      assert.equal(
        state.errors[0]!.observation?.identity.providerRequestId,
        "real-sdk-close",
      );
      assert.equal(state.errors[0]!.usage?.totalTokens, 4);
    },
  );
}

for (const entry of ["endpoint", "langchain"] as const) {
  test(`${entry}: a consumer error closes the iterator and survives a cleanup error`, async () => {
    const { config, state } = settings({
      observed: true,
      targets: 2,
      model: () => ({
        invoke: async () => undefined,
        stream: async () => ({
          [Symbol.asyncIterator](this: AsyncIterableIterator<unknown>) {
            return this;
          },
          next: async () => ({ done: false as const, value: partial() }),
          return: async () => {
            state.closes++;
            throw cleanupError;
          },
        }),
      }),
    });
    const iterator = await open(config, entry);
    const iterable = { [Symbol.asyncIterator]: () => iterator };
    await assert.rejects(
      async () => {
        for await (const _ of iterable) throw primaryError;
      },
      (error) => error === primaryError,
    );
    assert.equal(state.closes, 1);
    assert.equal(state.starts.length, 1);
    assert.equal(state.errors.length, 1);
    assert.equal(state.errors[0]!.usage?.totalTokens, 4);
  });
}
