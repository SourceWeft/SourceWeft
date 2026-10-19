import assert from "node:assert/strict";
import { createServer, type Server, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, test, vi } from "vitest";
import { createModelGateway } from "@sourceweft/model-gateway";
import { config } from "../config";
import { logger } from "../logger";
import { createGatewayLogger } from "./gateway-logger";
import { buildRoutedModelGatewayConfig } from "./runtime";
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
  vi.restoreAllMocks();
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
function routed(baseUrl: string, maxRetries: number): RoutedGatewayConfig {
  return {
    versionId: "gateway-logger-test",
    providers: {
      local: {
        gatewayConfigId: null,
        kind: "openai-compatible",
        baseUrl,
        isBYOK: false,
        enabled: true,
        configured: true,
        globalReady: true,
        requiresGlobalApiKey: true,
        hasGlobalApiKey: true,
        apiKey: "system-key",
        defaultHeaders: {},
        supports: ["chat"],
        timeoutMs: 5000,
        maxRetries,
      },
    },
    modelRoutes: {
      "chat-default": {
        strategy: "priority" as const,
        targets: [{ provider: "local", model: "local-model", priority: 1 }],
      },
    },
  };
}

test("createGatewayLogger forwards every level with the data object as structured fields", () => {
  const calls: Array<[string, string, Record<string, unknown> | undefined]> =
    [];
  const target = Object.fromEntries(
    (["debug", "info", "warn", "error"] as const).map((level) => [
      level,
      (message: string, meta?: Record<string, unknown>) => {
        calls.push([level, message, meta]);
      },
    ]),
  ) as Parameters<typeof createGatewayLogger>[0] & object;
  const gatewayLogger = createGatewayLogger(target);
  gatewayLogger.debug?.("d", { a: 1 });
  gatewayLogger.info?.("i");
  gatewayLogger.warn?.("w", { attempt: 2 });
  gatewayLogger.error?.("e", { errorCode: "UPSTREAM" });
  assert.deepEqual(calls, [
    ["debug", "d", { a: 1 }],
    ["info", "i", undefined],
    ["warn", "w", { attempt: 2 }],
    ["error", "e", { errorCode: "UPSTREAM" }],
  ]);
});

test("createGatewayLogger redacts credential-named fields before they reach the log", () => {
  const seen: Array<Record<string, unknown> | undefined> = [];
  const gatewayLogger = createGatewayLogger({
    debug: () => {},
    info: () => {},
    warn: (_message, meta) => {
      seen.push(meta);
    },
    error: () => {},
  });
  gatewayLogger.warn?.("model-gateway.failover", {
    provider: "local",
    apiKey: "sk-live",
    target: { providerModel: "m", api_key: "sk-nested", accessToken: "t" },
    headers: [{ Authorization: "Bearer x" }],
    maxTokens: 4096,
  });
  assert.deepEqual(seen, [
    {
      provider: "local",
      apiKey: "[REDACTED]",
      target: {
        providerModel: "m",
        api_key: "[REDACTED]",
        accessToken: "[REDACTED]",
      },
      headers: [{ Authorization: "[REDACTED]" }],
      maxTokens: 4096,
    },
  ]);
});

test("buildRoutedModelGatewayConfig carries a logger that writes to the shared logger", () => {
  const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
  const built = buildRoutedModelGatewayConfig(
    routed("https://example.invalid/v1", 0),
  );
  assert.ok(built.logger?.warn, "config has no logger");
  built.logger.warn("model-gateway.failover", { errorCode: "UPSTREAM" });
  assert.deepEqual(warn.mock.calls, [
    ["model-gateway.failover", { errorCode: "UPSTREAM" }],
  ]);
});

test("a model-gateway.retry warn from the SDK retry path lands on the shared logger with its fields", async () => {
  const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
  let chatRequests = 0;
  const origin = await serve((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      if (req.url !== "/v1/chat/completions") {
        res.statusCode = 404;
        res.end("{}");
        return;
      }
      chatRequests += 1;
      res.setHeader("Content-Type", "application/json");
      if (chatRequests === 1) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: { message: "upstream hiccup" } }));
        return;
      }
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
    });
  });
  const client = createModelGateway({
    ...buildRoutedModelGatewayConfig(routed(`${origin}/v1`, 1)),
    observeSink: undefined,
  });
  const result = await client.chat.complete({
    model: "chat-default",
    messages: [{ role: "user", content: "hello" }],
  });
  assert.equal(result.raw.content, "local reply");
  assert.equal(chatRequests, 2);

  const retries = warn.mock.calls.filter(
    ([message]) => message === "model-gateway.retry",
  );
  assert.equal(retries.length, 1, JSON.stringify(warn.mock.calls));
  const fields = retries[0]![1] as Record<string, unknown>;
  assert.equal(fields.attempt, 1);
  assert.equal(fields.maxRetries, 1);
  assert.equal(fields.willRetry, true);
  assert.equal(fields.errorCode, "UPSTREAM");
  assert.equal(fields.provider, "local");
  assert.equal(fields.providerModel, "local-model");
  assert.equal(typeof fields.elapsedMs, "number");
  assert.ok(!("apiKey" in fields));
  assert.ok(!JSON.stringify(fields).includes("system-key"));
});
