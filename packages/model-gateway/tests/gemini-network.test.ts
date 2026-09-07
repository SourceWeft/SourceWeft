import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createRequire } from "node:module";
import { HumanMessage, AIMessage, ToolMessage } from "@langchain/core/messages";
import { GeminiChatAdapter } from "../src/adapters/gemini-chat";
import { GeminiEmbeddingsAdapter } from "../src/adapters/gemini-embeddings";
import { createModelGateway, ModelGatewayError } from "../src/index";
import { normalizeGatewayError } from "../src/errors";
import type { ResolvedRequestTarget } from "../src/types";

const target: ResolvedRequestTarget = {
  provider: "gemini-local",
  providerKind: "gemini",
  providerModel: "gemini-2.5-flash",
  baseUrl: "http://models.internal:8080/proxy",
  apiKey: "user-key",
  defaultHeaders: {},
  supports: ["chat", "embeddings"],
  requestMetadata: {},
  routeDecision: {
    alias: "gemini",
    mode: "GLOBAL",
    strategy: "priority",
    provider: "gemini-local",
    providerKind: "gemini",
  },
};
const payload = {
  model: "gemini",
  messages: [{ role: "user" as const, content: "hello" }],
};
function response(
  parts: unknown[],
  usage = { promptTokenCount: 7, candidatesTokenCount: 2, totalTokenCount: 9 },
) {
  return {
    candidates: [
      { content: { role: "model", parts }, finishReason: "STOP", index: 0 },
    ],
    usageMetadata: usage,
  };
}
function isolate(t: TestContext) {
  const previous = process.env.GOOGLE_API_KEY;
  process.env.GOOGLE_API_KEY = "ambient-key-must-not-be-used";
  const ambient = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Gemini bypassed the host transport");
  });
  t.after(() => {
    if (previous === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = previous;
    assert.equal(ambient.mock.callCount(), 0);
  });
}
function chat(fetch: typeof globalThis.fetch, maxRetries = 0) {
  return new GeminiChatAdapter().createModel(target, payload, {
    fetch,
    maxRetries,
  });
}
function embeddings(
  fetch: typeof globalThis.fetch,
  maxRetries = 0,
  signal?: AbortSignal,
) {
  return new GeminiEmbeddingsAdapter().createModel(
    target,
    { model: "gemini", text: "hello" },
    { fetch, maxRetries, signal },
  );
}

test("Gemini native chat, streaming, tools, history and JSON schema use host fetch", async (t) => {
  isolate(t);
  const requests: Array<{ url: string; body: any; key: string | null }> = [];
  let mode = "text";
  const model = chat(async (input, init) => {
    const request = new Request(input, init);
    requests.push({
      url: request.url,
      body: await request.json(),
      key: request.headers.get("x-goog-api-key"),
    });
    if (mode === "stream")
      return new Response(
        [response([{ text: "hello " }]), response([{ text: "world" }])]
          .map((part) => `data: ${JSON.stringify(part)}\n\n`)
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    if (mode === "tool")
      return Response.json(
        response([
          { functionCall: { name: "lookup", args: { city: "Singapore" } } },
        ]),
      );
    if (mode === "schema")
      return Response.json(response([{ text: '{"city":"Singapore"}' }]));
    return Response.json(response([{ text: "hello" }]));
  });
  const result = await model.invoke("hello");
  assert.equal(result.content, "hello");
  assert.equal(result.usage_metadata?.total_tokens, 9);
  assert.equal(
    requests[0]?.url,
    `${target.baseUrl}/v1beta/models/${target.providerModel}:generateContent`,
  );
  mode = "stream";
  let content = "";
  let totalTokens = 0;
  for await (const part of await model.stream("hello")) {
    content += part.content;
    totalTokens += part.usage_metadata?.total_tokens ?? 0;
  }
  assert.equal(content, "hello world");
  assert.equal(totalTokens, 9);
  assert.match(requests.at(-1)!.url, /:streamGenerateContent\?alt=sse$/);
  mode = "tool";
  const tool = {
    type: "function" as const,
    function: {
      name: "lookup",
      description: "Look up a city",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
  };
  const call = await model.bindTools([tool]).invoke("lookup city");
  assert.equal(call.tool_calls?.[0]?.name, "lookup");
  assert.deepEqual(call.tool_calls?.[0]?.args, { city: "Singapore" });
  assert.equal(
    requests.at(-1)!.body.tools[0].functionDeclarations[0].name,
    "lookup",
  );
  mode = "text";
  await model.invoke([
    new HumanMessage("lookup city"),
    new AIMessage({
      content: "",
      tool_calls: [
        { id: "call-1", name: "lookup", args: { city: "Singapore" } },
      ],
    }),
    new ToolMessage({
      content: "found",
      tool_call_id: "call-1",
      name: "lookup",
    }),
  ]);
  assert.ok(
    requests
      .at(-1)!
      .body.contents.some((entry: any) =>
        entry.parts.some(
          (part: any) => part.functionResponse?.name === "lookup",
        ),
      ),
  );
  mode = "schema";
  const schema = {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  };
  assert.deepEqual(
    await model
      .withStructuredOutput(schema, { method: "jsonSchema" })
      .invoke("city"),
    { city: "Singapore" },
  );
  assert.ok(requests.at(-1)!.body.generationConfig.responseSchema);
  assert.ok(requests.every((request) => request.key === "user-key"));
});

test("Gemini cached-content clients retain host transport, origin and credentials", async (t) => {
  isolate(t);
  const requests: Request[] = [];
  const model = chat(async (input, init) => {
    requests.push(new Request(input, init));
    return Response.json(response([{ text: "cached" }]));
  });
  model.useCachedContent({
    name: "cachedContents/test",
    model: target.providerModel,
    contents: [{ role: "user", parts: [{ text: "cached context" }] }],
  });
  assert.equal((await model.invoke("hello")).content, "cached");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.headers.get("x-goog-api-key"), "user-key");
  assert.equal(
    new URL(requests[0]!.url).origin,
    new URL(target.baseUrl).origin,
  );
  assert.equal(
    (await requests[0]!.json()).cachedContent,
    "cachedContents/test",
  );
});

test("Gemini query and multi-batch embeddings preserve order and reject a failed batch", async (t) => {
  isolate(t);
  let fail = false;
  const requests: any[] = [];
  const model = embeddings(async (input, init) => {
    const request = new Request(input, init);
    assert.equal(request.headers.get("x-goog-api-key"), "user-key");
    const body = await request.json();
    requests.push(body);
    if (!body.requests)
      return Response.json({ embedding: { values: [0.25, 0.75] } });
    if (fail && body.requests[0].content.parts[0].text === "100")
      return Response.json(
        { error: { message: "invalid batch" } },
        { status: 400 },
      );
    return Response.json({
      embeddings: body.requests.map((entry: any) => ({
        values: [Number(entry.content.parts[0].text)],
      })),
    });
  });
  assert.deepEqual(await model.embedQuery("hello\nworld"), [0.25, 0.75]);
  assert.equal(requests[0].content.parts[0].text, "hello world");
  const texts = Array.from({ length: 101 }, (_, index) => String(index));
  assert.deepEqual(
    await model.embedDocuments(texts),
    texts.map(Number).map((value) => [value]),
  );
  fail = true;
  await assert.rejects(model.embedDocuments(texts), /invalid batch/);
});

test("Gemini host policy rejection is preserved and stops SDK retries and provider failover", async (t) => {
  isolate(t);
  const policy = new ModelGatewayError({
    code: "POLICY",
    message: "Endpoint denied",
    retryable: false,
  });
  const calls: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls.push(new Request(input, init).url);
    throw policy;
  };
  const gateway = createModelGateway({
    fetch,
    maxRetries: 2,
    providers: {
      gemini: { kind: "gemini", baseUrl: target.baseUrl, apiKey: "first-key" },
      second: {
        kind: "gemini",
        baseUrl: "https://second.example",
        apiKey: "second-key",
      },
    },
    modelRoutes: {
      gemini: {
        strategy: "priority",
        targets: [
          { provider: "gemini", model: target.providerModel, priority: 1 },
          { provider: "second", model: target.providerModel, priority: 2 },
        ],
      },
    },
  });
  const check = (error: unknown) => {
    assert.equal(error, policy);
    return true;
  };
  await assert.rejects(
    gateway.chat.complete(payload, { maxRetries: 2 }),
    check,
  );
  await assert.rejects(
    gateway.embeddings.embed(
      { model: "gemini", text: "hi" },
      { maxRetries: 2 },
    ),
    check,
  );
  await assert.rejects(
    gateway.embeddings.embedBatch(
      { model: "gemini", texts: ["hi"] },
      { maxRetries: 2 },
    ),
    check,
  );
  assert.equal(calls.length, 3);
  assert.ok(calls.every((url) => new URL(url).hostname === "models.internal"));
});

for (const status of [400, 429, 500]) {
  test(`Gemini retains LangChain retry classification for HTTP ${status}`, async (t) => {
    isolate(t);
    let calls = 0;
    const model = chat(async () => {
      calls++;
      return Response.json(
        { error: { message: "upstream rejected request" } },
        { status },
      );
    }, 1);
    await assert.rejects(model.invoke("hi"), (error: unknown) => {
      assert.equal(normalizeGatewayError(error).statusCode, status);
      return true;
    });
    assert.equal(calls, status === 500 ? 2 : 1);
  });
}

test("Gemini non-stream and embedding abort signals reach fetch without retrying", async (t) => {
  isolate(t);
  for (const operation of ["chat", "query", "batch"] as const) {
    const controller = new AbortController();
    let calls = 0;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const fetch: typeof globalThis.fetch = async (input, init) => {
      calls++;
      const request = new Request(input, init);
      assert.ok(request.signal);
      return new Promise<Response>((_, reject) => {
        request.signal.addEventListener(
          "abort",
          () => reject(new DOMException("cancelled", "AbortError")),
          { once: true },
        );
        started();
      });
    };
    const promise =
      operation === "chat"
        ? chat(fetch, 2).invoke("hi", { signal: controller.signal })
        : operation === "query"
          ? embeddings(fetch, 2, controller.signal).embedQuery("hi")
          : embeddings(fetch, 2, controller.signal).embedDocuments(["hi"]);
    const rejected = assert.rejects(promise, /abort|cancel/i);
    await ready;
    controller.abort();
    await rejected;
    assert.equal(calls, 1);
  }
});

test("the patched CommonJS entry also injects fetch for native chat and embeddings", async (t) => {
  isolate(t);
  const { ChatGoogleGenerativeAI, GoogleGenerativeAIEmbeddings } =
    createRequire(import.meta.url)(
      "@langchain/google-genai",
    ) as typeof import("@langchain/google-genai");
  let calls = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls++;
    const request = new Request(input, init);
    assert.equal(request.headers.get("x-goog-api-key"), "cjs-user-key");
    return request.url.includes(":embedContent")
      ? Response.json({ embedding: { values: [1, 2] } })
      : Response.json(response([{ text: "cjs" }]));
  };
  const options = {
    model: target.providerModel,
    apiKey: "cjs-user-key",
    baseUrl: target.baseUrl,
    fetch,
    maxRetries: 0,
  };
  assert.equal(
    (await new ChatGoogleGenerativeAI(options).invoke("hello")).content,
    "cjs",
  );
  assert.deepEqual(
    await new GoogleGenerativeAIEmbeddings(options).embedQuery("hello"),
    [1, 2],
  );
  assert.equal(calls, 2);
});
