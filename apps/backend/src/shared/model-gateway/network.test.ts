import assert from "node:assert/strict";
import { createServer, type Server, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, test, vi } from "vitest";
import {
  createModelGateway,
  ModelGatewayError,
} from "@sourceweft/model-gateway";
import { config } from "../config";
import {
  checkEndpointUrl,
  validateEndpointUrl,
} from "../security/endpoint-policy";
import { createLlmFetch, llmEndpointPolicy } from "./network";
import { buildRoutedModelGatewayConfig } from "./runtime";
import {
  discoverGatewayCatalog,
  discoverByokModelCandidates,
} from "./catalog-discovery";
import type { RoutedGatewayConfig } from "./types";

const originalOrigins = config.llmAllowedInternalOrigins;
const originalChecks = config.endpointAddressChecksEnabled;
const servers: Server[] = [];
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  config.llmAllowedInternalOrigins = [];
  config.endpointAddressChecksEnabled = true;
});
afterEach(async () => {
  config.llmAllowedInternalOrigins = originalOrigins;
  config.endpointAddressChecksEnabled = originalChecks;
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
function routed(baseUrl: string, enabled = true): RoutedGatewayConfig {
  return {
    versionId: "network-test",
    providers: {
      local: {
        gatewayConfigId: null,
        kind: "openai-compatible",
        baseUrl,
        isBYOK: false,
        enabled,
        configured: true,
        globalReady: enabled,
        requiresGlobalApiKey: true,
        hasGlobalApiKey: true,
        apiKey: "system-key",
        defaultHeaders: {},
        supports: ["chat", "embeddings"],
        timeoutMs: 5000,
        maxRetries: 0,
      },
    },
    modelRoutes: Object.fromEntries(
      ["chat-default", "embedding-default"].map((alias) => [
        alias,
        {
          strategy: "priority" as const,
          targets: [{ provider: "local", model: "local-model", priority: 1 }],
        },
      ]),
    ),
  };
}
function gateway(input: RoutedGatewayConfig) {
  return createModelGateway({
    ...buildRoutedModelGatewayConfig(input),
    observeSink: undefined,
  });
}
const messages = [{ role: "user" as const, content: "hello" }];

test("development policy permits fake-IP System definitions and unlisted local catalog connections", async () => {
  config.endpointAddressChecksEnabled = false;
  const policy = llmEndpointPolicy(["http://198.18.0.20/v1"]);
  assert.equal(policy.enforceAddressChecks, false);
  assert.equal(
    checkEndpointUrl("http://198.18.0.21/v1", policy).hostname,
    "198.18.0.21",
  );
  let auth: string | undefined;
  const origin = await serve((req, res) => {
    auth = req.headers.authorization;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ data: [{ id: "dev-model" }] }));
  });
  const candidates = await discoverByokModelCandidates({
    providerName: "local",
    providerKind: "openai-compatible",
    baseUrl: origin,
    apiKey: "user-key",
    fetch: createLlmFetch(llmEndpointPolicy([])),
  });
  assert.ok(candidates.some((candidate) => candidate.modelId === "dev-model"));
  assert.equal(auth, "Bearer user-key");
});
function isPolicy(error: unknown) {
  assert.ok(error instanceof ModelGatewayError);
  assert.equal(error.code, "POLICY");
  assert.equal(error.retryable, false);
  return true;
}

test("System declarations and BYOK origins grant exact network permission in production", async () => {
  config.llmAllowedInternalOrigins = ["http://10.2.3.4:8000"];
  const policy = llmEndpointPolicy([
    "http://model-service.:8080/v1",
    "https://llm.internal/v1",
  ]);
  for (const baseUrl of [
    "http://model-service:8080/v1",
    "https://llm.internal/v1",
    "http://10.2.3.4:8000/v1",
  ]) {
    await validateEndpointUrl(baseUrl, policy, async () => [
      { address: "10.1.2.3", family: 4 },
    ]);
  }
  for (const denied of [
    "http://10.2.3.4:8001/v1",
    "http://mcp-only.internal/v1",
    "https://10.2.3.5/v1",
  ]) {
    assert.throws(() => checkEndpointUrl(denied, policy));
  }
  assert.throws(() =>
    llmEndpointPolicy(["http://user:secret@model-service:8080/v1"]),
  );
  assert.throws(() => llmEndpointPolicy(["http://169.254.169.254/latest"]));
  const mapped = "http://[::ffff:7f00:1]:8080/v1";
  assert.throws(() => checkEndpointUrl(mapped, llmEndpointPolicy([])));
  assert.equal(
    checkEndpointUrl(mapped, llmEndpointPolicy([mapped])).hostname,
    "[::ffff:7f00:1]",
  );
});

test("real local SDK chat, stream, embeddings and catalog use declared endpoints and explicit keys", async () => {
  const seen: Array<{ path: string; auth: string | undefined }> = [];
  const origin = await serve((req, res) => {
    seen.push({ path: req.url!, auth: req.headers.authorization });
    let body = "";
    req.on("data", (part) => {
      body += part;
    });
    req.on("end", () => {
      const payload = body ? JSON.parse(body) : {};
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/v1/models") {
        res.end(JSON.stringify({ data: [{ id: "local-model" }] }));
      } else if (req.url === "/v1/embeddings") {
        const vector = [0.25, 0.75];
        const embedding =
          payload.encoding_format === "base64"
            ? Buffer.from(new Float32Array(vector).buffer).toString("base64")
            : vector;
        res.end(
          JSON.stringify({
            data: [{ index: 0, embedding }],
            usage: { prompt_tokens: 1, total_tokens: 1 },
          }),
        );
      } else if (req.url === "/v1/chat/completions" && payload.stream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.end(
          `data: ${JSON.stringify({ id: "local-stream", object: "chat.completion.chunk", model: "local-model", choices: [{ index: 0, delta: { role: "assistant", content: "local stream" }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`,
        );
      } else if (req.url === "/v1/chat/completions") {
        res.end(
          JSON.stringify({
            id: "local-chat",
            object: "chat.completion",
            model: "local-model",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "local reply" },
                finish_reason: "stop",
              },
            ],
          }),
        );
      } else {
        res.statusCode = 404;
        res.end("{}");
      }
    });
  });
  const baseUrl = `${origin}/v1`;
  const client = gateway(routed(baseUrl));
  assert.equal(
    (await client.chat.complete({ model: "chat-default", messages })).raw
      .content,
    "local reply",
  );
  let streamed = "";
  for await (const event of client.chat.stream({
    model: "chat-default",
    messages,
  })) {
    if (event.type === "chunk") streamed += event.chunk.content;
    if (event.type === "error") throw new Error(JSON.stringify(event));
  }
  assert.equal(streamed, "local stream");
  assert.deepEqual(
    (
      await client.embeddings.embed({
        model: "embedding-default",
        text: "hello",
      })
    ).embedding,
    [0.25, 0.75],
  );
  const candidates = await discoverGatewayCatalog({
    gateway: {
      slug: "local",
      providerName: "local",
      providerKind: "openai-compatible",
      baseUrl,
      apiKey: "system-key",
      supports: ["chat", "tool_calling"],
    },
    resolveCapabilities: () => ({
      id: "local-model",
      modality: "chat",
      reasoning: false,
      reasoningEfforts: [],
      toolCall: false,
      structuredOutput: false,
      vision: false,
      sources: ["fixture"],
    }),
  });
  assert.ok(
    candidates.some((candidate) => candidate.modelId === "local-model"),
  );
  const byok = gateway(routed(baseUrl, false));
  await assert.rejects(
    byok.chat.complete({ model: "chat-default", messages }),
    /No globally ready route target/,
  );
  const input = {
    model: "local-model",
    messages,
    executionMode: "BYOK" as const,
    byok: { provider: "local", apiKey: "user-key" },
  };
  assert.equal((await byok.chat.complete(input)).raw.content, "local reply");
  await assert.rejects(
    byok.chat.complete({ ...input, byok: { provider: "local" } }),
    /API key|credential/i,
  );
  await discoverByokModelCandidates({
    providerName: "local",
    providerKind: "openai-compatible",
    baseUrl,
    apiKey: "user-key",
    fetch: createLlmFetch(llmEndpointPolicy([baseUrl])),
  });
  assert.deepEqual(
    seen.map((request) => request.auth),
    [
      "Bearer system-key",
      "Bearer system-key",
      "Bearer system-key",
      "Bearer system-key",
      "Bearer user-key",
      "Bearer user-key",
    ],
  );
  assert.deepEqual(
    seen.map((request) => request.path),
    [
      "/v1/chat/completions",
      "/v1/chat/completions",
      "/v1/embeddings",
      "/v1/models",
      "/v1/chat/completions",
      "/v1/models",
    ],
  );
});

test("SDK-wrapped redirect refusal never advances to the next GLOBAL provider", async () => {
  let destinationRequests = 0;
  let redirectRequests = 0;
  const destination = await serve((_req, res) => {
    destinationRequests++;
    res.end("{}");
  });
  const origin = await serve((_req, res) => {
    redirectRequests++;
    res.writeHead(307, { location: `${destination}/stolen` });
    res.end();
  });
  const input = routed(`${origin}/v1`);
  input.providers.local!.maxRetries = 2;
  input.providers.secondary = {
    ...input.providers.local!,
    baseUrl: `${destination}/v1`,
  };
  input.modelRoutes["chat-default"]!.targets.push({
    provider: "secondary",
    model: "local-model",
    priority: 2,
  });
  // Policy refusals stop immediately even when the Provider permits retries.
  await assert.rejects(
    gateway(input).chat.complete({ model: "chat-default", messages }),
    isPolicy,
  );
  assert.equal(redirectRequests, 1);
  assert.equal(destinationRequests, 0);
});

test("response EOF and cancellation release connections without buffering the whole stream", async () => {
  let connectionClosed: Promise<void> | undefined;
  const origin = await serve((req, res) => {
    connectionClosed = new Promise((resolve) =>
      req.socket.once("close", () => resolve()),
    );
    if (req.url === "/stream") {
      res.writeHead(200);
      res.write("first");
    } else res.end("done");
  });
  const fetch = createLlmFetch(llmEndpointPolicy([origin]));
  const complete = await fetch(origin);
  assert.equal(await complete.text(), "done");
  await connectionClosed;
  const streaming = await fetch(`${origin}/stream`);
  const reader = streaming.body!.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), "first");
  await reader.cancel();
  await connectionClosed;
  // A denial belongs to this request, not to every future model invocation.
  await assert.rejects(fetch("http://169.254.169.254"), isPolicy);
  assert.equal(await (await fetch(origin)).text(), "done");
  await connectionClosed;
});

test("failed catalog requests cancel an unfinished error body and release its connection", async () => {
  let connectionClosed: Promise<void> | undefined;
  const origin = await serve((req, res) => {
    connectionClosed = new Promise((resolve) =>
      req.socket.once("close", () => resolve()),
    );
    res.writeHead(503);
    res.write("unavailable");
  });
  await assert.rejects(
    discoverByokModelCandidates({
      providerName: "local",
      providerKind: "openai-compatible",
      baseUrl: origin,
      apiKey: "user-key",
      fetch: createLlmFetch(llmEndpointPolicy([origin])),
    }),
    /503/,
  );
  await connectionClosed;
});
