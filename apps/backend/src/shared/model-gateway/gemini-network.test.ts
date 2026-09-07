import assert from "node:assert/strict";
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, test, vi } from "vitest";
import {
  createModelGateway,
  ModelGatewayError,
} from "@sourceweft/model-gateway";
import { createLlmFetch, llmEndpointPolicy } from "./network";

const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});
async function serve(handler: RequestListener) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
function result(text: string) {
  return {
    candidates: [
      {
        content: { role: "model", parts: [{ text }] },
        finishReason: "STOP",
        index: 0,
      },
    ],
    usageMetadata: {
      promptTokenCount: 2,
      candidatesTokenCount: 1,
      totalTokenCount: 3,
    },
  };
}
function gateway(
  baseUrl: string,
  fetch = createLlmFetch(llmEndpointPolicy([baseUrl])),
) {
  return createModelGateway({
    fetch,
    maxRetries: 2,
    providers: { local: { kind: "gemini", baseUrl, apiKey: "system-key" } },
    modelRoutes: {
      gemini: {
        strategy: "priority",
        targets: [
          { provider: "local", model: "gemini-2.5-flash", priority: 1 },
        ],
      },
    },
  });
}
const chat = {
  model: "gemini",
  messages: [{ role: "user" as const, content: "hello" }],
};
const isPolicy = (error: unknown) => {
  assert.ok(error instanceof ModelGatewayError);
  assert.equal(error.code, "POLICY");
  assert.equal(error.retryable, false);
  return true;
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("native Gemini talks to a declared local endpoint for chat, SSE and embeddings with isolated keys", async () => {
  vi.stubEnv("GOOGLE_API_KEY", "ambient-must-not-be-sent");
  const seen: Array<{ path: string; key: string | string[] | undefined }> = [];
  const origin = await serve((request, response) => {
    seen.push({ path: request.url!, key: request.headers["x-goog-api-key"] });
    let body = "";
    request.on("data", (part) => {
      body += part;
    });
    request.on("end", () => {
      const payload = JSON.parse(body);
      response.setHeader("Content-Type", "application/json");
      if (request.url!.includes(":batchEmbedContents"))
        response.end(
          JSON.stringify({
            embeddings: payload.requests.map(() => ({ values: [0.25, 0.75] })),
          }),
        );
      else if (request.url!.includes(":embedContent"))
        response.end(JSON.stringify({ embedding: { values: [0.25, 0.75] } }));
      else if (request.url!.includes(":streamGenerateContent")) {
        response.setHeader("Content-Type", "text/event-stream");
        response.end(`data: ${JSON.stringify(result("stream"))}\n\n`);
      } else response.end(JSON.stringify(result("local")));
    });
  });
  const client = gateway(`${origin}/native`);
  assert.equal((await client.chat.complete(chat)).raw.content, "local");
  let content = "";
  for await (const event of client.chat.stream(chat)) {
    assert.notEqual(event.type, "error");
    if (event.type === "chunk") content += event.chunk.content;
  }
  assert.equal(content, "stream");
  assert.deepEqual(
    (await client.embeddings.embed({ model: "gemini", text: "hello" }))
      .embedding,
    [0.25, 0.75],
  );
  assert.deepEqual(
    (
      await client.embeddings.embedBatch({
        model: "gemini",
        texts: ["one", "two"],
      })
    ).embeddings,
    [
      [0.25, 0.75],
      [0.25, 0.75],
    ],
  );
  assert.equal(
    (
      await client.chat.complete({
        ...chat,
        model: "gemini-2.5-flash",
        executionMode: "BYOK",
        byok: { provider: "local", apiKey: "workspace-key" },
      })
    ).raw.content,
    "local",
  );
  assert.deepEqual(
    seen.map((request) => request.key),
    ["system-key", "system-key", "system-key", "system-key", "workspace-key"],
  );
  assert.ok(
    seen.every((request) => request.path.startsWith("/native/v1beta/models/")),
  );
  await assert.rejects(
    client.chat.complete({
      ...chat,
      executionMode: "BYOK",
      byok: { provider: "local" },
    }),
  );
  assert.equal(seen.length, 5);
});

test("native Gemini policy refusals do not reach an unlisted socket or retry", async () => {
  let connections = 0;
  const origin = await serve((_request, response) => {
    connections++;
    response.end("unexpected");
  });
  const fetch = createLlmFetch({
    enforceAddressChecks: true,
    allowedInternalOrigins: [],
  });
  let attempts = 0;
  const client = gateway(origin, async (input, init) => {
    attempts++;
    return fetch(input, init);
  });
  await assert.rejects(client.chat.complete(chat, { maxRetries: 2 }), isPolicy);
  await assert.rejects(
    client.embeddings.embedBatch(
      { model: "gemini", texts: ["hello"] },
      { maxRetries: 2 },
    ),
    isPolicy,
  );
  assert.equal(attempts, 2);
  assert.equal(connections, 0);
});

test("native Gemini rejects cross-origin redirects before forwarding credentials", async () => {
  let destinationCalls = 0;
  let originalCalls = 0;
  const destination = await serve((_request, response) => {
    destinationCalls++;
    response.end("unexpected");
  });
  const origin = await serve((_request, response) => {
    originalCalls++;
    response.writeHead(307, { Location: `${destination}/capture` });
    response.end();
  });
  const client = gateway(
    origin,
    createLlmFetch(llmEndpointPolicy([origin, destination])),
  );
  await assert.rejects(client.chat.complete(chat, { maxRetries: 2 }), isPolicy);
  assert.equal(originalCalls, 1);
  assert.equal(destinationCalls, 0);
});

for (const operation of ["chat", "query", "batch"] as const) {
  test(`native Gemini ${operation} abort closes the real request without retrying`, async () => {
    const ready = deferred();
    const closed = deferred();
    let calls = 0;
    const origin = await serve((request, response) => {
      calls++;
      request.resume();
      response.on("close", closed.resolve);
      ready.resolve();
    });
    const controller = new AbortController();
    const client = gateway(origin);
    const promise =
      operation === "chat"
        ? client.chat.complete(chat, {
            signal: controller.signal,
            maxRetries: 2,
          })
        : operation === "query"
          ? client.embeddings.embed(
              { model: "gemini", text: "hello" },
              { signal: controller.signal, maxRetries: 2 },
            )
          : client.embeddings.embedBatch(
              { model: "gemini", texts: ["hello"] },
              { signal: controller.signal, maxRetries: 2 },
            );
    const rejected = assert.rejects(promise, /abort|cancel/i);
    await ready.promise;
    controller.abort();
    await rejected;
    await closed.promise;
    assert.equal(calls, 1);
  });
}

test("native Gemini streaming abort surfaces a terminal error and closes the socket", async () => {
  const closed = deferred();
  let calls = 0;
  const origin = await serve((request, response) => {
    calls++;
    request.resume();
    response.on("close", closed.resolve);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(`data: ${JSON.stringify(result("first"))}\n\n`);
  });
  const controller = new AbortController();
  const client = gateway(origin);
  let content = "";
  let terminalErrors = 0;
  for await (const event of client.chat.stream(chat, {
    signal: controller.signal,
    maxRetries: 2,
  })) {
    if (event.type === "chunk") {
      content += event.chunk.content;
      controller.abort();
    }
    if (event.type === "error") terminalErrors++;
  }
  await closed.promise;
  assert.equal(content, "first");
  assert.equal(terminalErrors, 1);
  assert.equal(calls, 1);
});
