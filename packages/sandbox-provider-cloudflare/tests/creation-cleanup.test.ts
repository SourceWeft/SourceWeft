import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test, type TestContext } from "node:test";
import { SANDBOX_PROVIDER_ERROR_CODES } from "@sourceweft/builtin-tool-sandbox";
import { sandboxErrorDiagnostic } from "../../builtin-tool-sandbox/src/runtime/errors";
import {
  CloudflareBridgeHttpError,
  CloudflareSandboxProvider,
} from "../src/cloudflare-provider";

const createdId = "own-created-sandbox";
type Cleanup = {
  providerSandboxId: string;
  status: "delete-requested" | "already-missing" | "unconfirmed";
  reason?: string;
};
async function fixture(
  t: TestContext,
  options: {
    stamp?: "failure" | "timeout";
    cleanupStatus?: number;
    cleanupBody?: string;
    createFails?: boolean;
    createWithoutId?: boolean;
    cleanupHang?: "headers" | "body";
  },
) {
  const requests: string[] = [];
  const alive = new Set(["existing-user-sandbox"]);
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    request.resume();
    if (request.method === "POST") {
      if (options.createFails) {
        response.writeHead(503).end("create rejected before allocating an id");
        return;
      }
      if (options.createWithoutId) {
        alive.add("unreported-created-sandbox");
        response.setHeader("content-type", "application/json");
        response.end("{}");
        return;
      }
      alive.add(createdId);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ id: createdId }));
      return;
    }
    if (request.method === "PUT") {
      if (options.stamp === "timeout") return;
      response.writeHead(503).end("original stamp initialization failed");
      return;
    }
    if (request.method === "DELETE") {
      assert.equal(request.url, `/v1/sandbox/${createdId}`);
      if (options.cleanupHang) {
        if (options.cleanupHang === "body") {
          response.writeHead(503, { "content-type": "text/plain" });
          response.flushHeaders();
        }
        return;
      }
      const status = options.cleanupStatus ?? 200;
      if (
        status === 200 ||
        options.cleanupBody?.includes(
          SANDBOX_PROVIDER_ERROR_CODES.instanceMissing,
        )
      )
        alive.delete(createdId);
      response.writeHead(status).end(options.cleanupBody ?? "cleanup response");
      return;
    }
    response.writeHead(500).end("unexpected request");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const provider = new CloudflareSandboxProvider({
    bridgeUrl: `http://127.0.0.1:${address.port}`,
    apiKey: "fixture-key",
    maxOutputChars: 1000,
    createCleanupTimeoutMs: 40,
    fetchImpl: (input, init) =>
      fetch(input, {
        ...init,
        ...(options.stamp === "timeout" && init?.method === "PUT"
          ? { signal: AbortSignal.timeout(40) }
          : {}),
      }),
  });
  return { provider, requests, alive };
}
async function failedCreate(provider: CloudflareSandboxProvider) {
  let failure:
    (Error & { code?: string; creationCleanup?: Cleanup }) | undefined;
  try {
    await provider.createSandbox({
      ttlSeconds: 60,
      labels: { purpose: "fixture" },
    });
  } catch (error) {
    assert.ok(error instanceof Error);
    failure = error;
  }
  assert.ok(failure, "initialization must still fail");
  return failure;
}
for (const stamp of ["failure", "timeout"] as const) {
  test(`real HTTP ${stamp} during stamp initialization deletes only the new sandbox`, async (t) => {
    const state = await fixture(t, { stamp });
    const failure = await failedCreate(state.provider);
    assert.equal(
      failure.code,
      stamp === "timeout"
        ? SANDBOX_PROVIDER_ERROR_CODES.timeout
        : SANDBOX_PROVIDER_ERROR_CODES.unavailable,
    );
    if (stamp === "failure") {
      assert.ok(failure.cause instanceof CloudflareBridgeHttpError);
      assert.equal(failure.cause.status, 503);
      assert.match(
        failure.cause.message,
        /original stamp initialization failed/,
      );
    }
    assert.deepEqual(
      state.requests.map((value) => value.split(" ")[0]),
      ["POST", "PUT", "DELETE"],
    );
    assert.deepEqual([...state.alive], ["existing-user-sandbox"]);
  });
}
for (const status of [503, 404]) {
  test(`real HTTP cleanup ${status} preserves the initialization error and recovery id`, async (t) => {
    const state = await fixture(t, {
      cleanupStatus: status,
      cleanupBody:
        status === 404
          ? "<html>missing route</html>"
          : "cleanup service unavailable",
    });
    const failure = await failedCreate(state.provider);
    assert.equal(failure.code, SANDBOX_PROVIDER_ERROR_CODES.unavailable);
    assert.ok(failure.cause instanceof CloudflareBridgeHttpError);
    assert.equal(failure.cause.status, 503);
    assert.equal(failure.cause.operation, "create");
    assert.match(failure.cause.message, /original stamp initialization failed/);
    assert.equal(failure.creationCleanup?.providerSandboxId, createdId);
    assert.equal(failure.creationCleanup?.status, "unconfirmed");
    assert.match(
      failure.creationCleanup?.reason ?? "",
      new RegExp(String(status)),
    );
    assert.ok(state.alive.has(createdId));
    assert.ok(state.alive.has("existing-user-sandbox"));
    const diagnostic = sandboxErrorDiagnostic(failure) as {
      creationCleanup?: Cleanup;
    };
    assert.equal(diagnostic.creationCleanup?.providerSandboxId, createdId);
  });
}
test("real HTTP structured already-missing is an idempotent creation cleanup", async (t) => {
  const state = await fixture(t, {
    cleanupStatus: 404,
    cleanupBody: JSON.stringify({
      code: SANDBOX_PROVIDER_ERROR_CODES.instanceMissing,
      error: "instance gone",
    }),
  });
  const failure = await failedCreate(state.provider);
  assert.equal(failure.code, SANDBOX_PROVIDER_ERROR_CODES.unavailable);
  assert.equal(failure.creationCleanup?.status, "already-missing");
  assert.deepEqual([...state.alive], ["existing-user-sandbox"]);
});
test("a rejected create with no returned id never deletes any sandbox", async (t) => {
  const state = await fixture(t, { createFails: true });
  const failure = await failedCreate(state.provider);
  assert.equal(failure.code, SANDBOX_PROVIDER_ERROR_CODES.unavailable);
  assert.equal(failure.creationCleanup, undefined);
  assert.deepEqual(state.requests, ["POST /v1/sandbox"]);
  assert.deepEqual([...state.alive], ["existing-user-sandbox"]);
});

test("real HTTP stamp timeout remains the primary error when cleanup also fails", async (t) => {
  const state = await fixture(t, {
    stamp: "timeout",
    cleanupStatus: 503,
    cleanupBody: "cleanup unavailable",
  });
  const failure = await failedCreate(state.provider);
  assert.equal(failure.code, SANDBOX_PROVIDER_ERROR_CODES.timeout);
  assert.ok(failure.cause instanceof Error);
  assert.match(failure.cause.message, /timeout/i);
  assert.equal(failure.creationCleanup?.providerSandboxId, createdId);
  assert.equal(failure.creationCleanup?.status, "unconfirmed");
  assert.deepEqual(
    state.requests.map((value) => value.split(" ")[0]),
    ["POST", "PUT", "DELETE"],
  );
  assert.ok(state.alive.has(createdId));
  assert.ok(state.alive.has("existing-user-sandbox"));
});

test("a successful HTTP create response without an id never guesses a deletion target", async (t) => {
  const state = await fixture(t, { createWithoutId: true });
  const failure = await failedCreate(state.provider);
  assert.match(failure.message, /returned no sandbox id/);
  assert.equal(failure.creationCleanup, undefined);
  assert.deepEqual(state.requests, ["POST /v1/sandbox"]);
  assert.deepEqual(
    [...state.alive],
    ["existing-user-sandbox", "unreported-created-sandbox"],
  );
});

for (const stamp of ["failure", "timeout"] as const) {
  for (const cleanupHang of ["headers", "body"] as const) {
    test(`real HTTP hanging cleanup ${cleanupHang} is bounded after stamp ${stamp}`, async (t) => {
      const state = await fixture(t, { stamp, cleanupHang });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const started = performance.now();
      try {
        const failure = await Promise.race([
          failedCreate(state.provider),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("cleanup exceeded the fixture watchdog")),
              1000,
            );
          }),
        ]);
        assert.ok(performance.now() - started < 1000);
        assert.equal(
          failure.code,
          stamp === "timeout"
            ? SANDBOX_PROVIDER_ERROR_CODES.timeout
            : SANDBOX_PROVIDER_ERROR_CODES.unavailable,
        );
        if (stamp === "failure") {
          assert.ok(failure.cause instanceof CloudflareBridgeHttpError);
          assert.match(
            failure.cause.message,
            /original stamp initialization failed/,
          );
        }
        assert.equal(failure.creationCleanup?.status, "unconfirmed");
        assert.equal(failure.creationCleanup?.providerSandboxId, createdId);
        assert.match(failure.creationCleanup?.reason ?? "", /timeout|aborted/i);
        assert.deepEqual(
          state.requests.map((value) => value.split(" ")[0]),
          ["POST", "PUT", "DELETE"],
        );
        assert.deepEqual(
          [...state.alive],
          ["existing-user-sandbox", createdId],
        );
      } finally {
        clearTimeout(timer);
      }
    });
  }
}
