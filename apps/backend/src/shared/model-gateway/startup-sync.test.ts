import assert from "node:assert/strict";
import { test } from "vitest";
import { ModelCatalogUnavailableError } from "./config-sync";
import {
  STARTUP_SYNC_RETRY_DELAYS_MS,
  syncGlobalModelGatewayConfigAtStartup,
} from "./startup-sync";

function harness(input: {
  results: Array<"ok" | "catalog" | "config">;
  activeVersion: { id: string } | null;
}) {
  const results = [...input.results];
  const scheduled: Array<{ run: () => void; delayMs: number }> = [];
  let syncCalls = 0;
  return {
    scheduled,
    get syncCalls() {
      return syncCalls;
    },
    dependencies: {
      sync: async () => {
        syncCalls += 1;
        const result = results.shift() ?? "ok";
        if (result === "catalog") {
          throw new ModelCatalogUnavailableError("models.dev unreachable");
        }
        if (result === "config") {
          throw new Error("Invalid global model gateway config");
        }
      },
      findActiveVersion: async () => input.activeVersion,
      schedule: (run: () => void, delayMs: number) => {
        scheduled.push({ run, delayMs });
      },
    },
  };
}

/** Run the next scheduled retry and let its promise settle. */
async function runNextRetry(scheduled: Array<{ run: () => void }>) {
  scheduled.shift()!.run();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("a successful startup sync schedules nothing", async () => {
  const h = harness({ results: ["ok"], activeVersion: { id: "v1" } });
  await syncGlobalModelGatewayConfigAtStartup(undefined, h.dependencies);
  assert.equal(h.syncCalls, 1);
  assert.equal(h.scheduled.length, 0);
});

test("a catalog failure with an active version keeps starting and retries with backoff until a sync succeeds", async () => {
  const h = harness({
    results: ["catalog", "catalog", "catalog", "ok"],
    activeVersion: { id: "v1" },
  });

  await syncGlobalModelGatewayConfigAtStartup(undefined, h.dependencies);
  assert.deepEqual(
    h.scheduled.map((entry) => entry.delayMs),
    [STARTUP_SYNC_RETRY_DELAYS_MS[0]],
  );

  await runNextRetry(h.scheduled);
  assert.deepEqual(
    h.scheduled.map((entry) => entry.delayMs),
    [STARTUP_SYNC_RETRY_DELAYS_MS[1]],
  );
  await runNextRetry(h.scheduled);
  await runNextRetry(h.scheduled);

  // The fourth call succeeded: no further retry is scheduled.
  assert.equal(h.syncCalls, 4);
  assert.equal(h.scheduled.length, 0);
});

test("the retry backoff stays at its longest delay", async () => {
  const h = harness({
    results: Array(8).fill("catalog"),
    activeVersion: { id: "v1" },
  });
  await syncGlobalModelGatewayConfigAtStartup(undefined, h.dependencies);
  const delays: number[] = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    delays.push(h.scheduled[0]!.delayMs);
    await runNextRetry(h.scheduled);
  }
  const longest = STARTUP_SYNC_RETRY_DELAYS_MS.at(-1)!;
  assert.deepEqual(delays.slice(-2), [longest, longest]);
});

test("a catalog failure with no active version fails startup", async () => {
  const h = harness({ results: ["catalog"], activeVersion: null });
  await assert.rejects(
    syncGlobalModelGatewayConfigAtStartup(undefined, h.dependencies),
    ModelCatalogUnavailableError,
  );
  assert.equal(h.scheduled.length, 0);
});

test("an invalid configuration fails startup even with an active version", async () => {
  const h = harness({ results: ["config"], activeVersion: { id: "v1" } });
  await assert.rejects(
    syncGlobalModelGatewayConfigAtStartup(undefined, h.dependencies),
    /Invalid global model gateway config/,
  );
  assert.equal(h.scheduled.length, 0);
});

test("a retry that hits a non-catalog error stops retrying", async () => {
  const h = harness({
    results: ["catalog", "config"],
    activeVersion: { id: "v1" },
  });
  await syncGlobalModelGatewayConfigAtStartup(undefined, h.dependencies);
  await runNextRetry(h.scheduled);
  assert.equal(h.syncCalls, 2);
  assert.equal(h.scheduled.length, 0);
});
