import assert from "node:assert/strict";
import { Hono } from "hono";
import { afterEach, beforeEach, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../../shared/config", () => ({
  config: {
    apiPerformance: {
      largeResponseThresholdBytes: 512,
      slowRequestThresholdMs: 1_000,
    },
  },
}));

vi.mock("../../shared/logger", () => ({
  logger: {
    info: mocks.info,
    warn: mocks.warn,
  },
}));

import { metrics } from "../../shared/metrics";
import { performanceLoggingMiddleware } from "./performance-logging";

function createApp(input: { responseSize: number; status?: number }) {
  const app = new Hono();
  app.use("/v1/workspaces/:workspaceId/*", performanceLoggingMiddleware);
  app.get("/v1/workspaces/:workspaceId/test", (c) => {
    c.header("content-length", String(input.responseSize));
    return c.body("x", (input.status ?? 200) as never);
  });
  return app;
}

function setDuration(durationMs: number) {
  vi.spyOn(performance, "now")
    .mockReturnValueOnce(100)
    .mockReturnValueOnce(100 + durationMs);
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

test("large-only responses identify the large response threshold", async () => {
  setDuration(50);
  await createApp({ responseSize: 512 }).request(
    "/v1/workspaces/workspace-1/test",
  );

  assert.deepEqual(mocks.info.mock.calls[0]?.[1]?.thresholdsExceeded, [
    "large_response",
  ]);
});

test("slow-only responses identify the slow request threshold", async () => {
  setDuration(1_000);
  await createApp({ responseSize: 100 }).request(
    "/v1/workspaces/workspace-1/test",
  );

  assert.deepEqual(mocks.info.mock.calls[0]?.[1]?.thresholdsExceeded, [
    "slow_request",
  ]);
});

test("responses crossing both thresholds report both reasons", async () => {
  setDuration(1_200);
  await createApp({ responseSize: 900 }).request(
    "/v1/workspaces/workspace-1/test",
  );

  assert.deepEqual(mocks.info.mock.calls[0]?.[1]?.thresholdsExceeded, [
    "slow_request",
    "large_response",
  ]);
});

test("responses below both thresholds do not emit a performance event", async () => {
  setDuration(20);
  await createApp({ responseSize: 100 }).request(
    "/v1/workspaces/workspace-1/test",
  );

  assert.equal(mocks.info.mock.calls.length, 0);
  assert.equal(mocks.warn.mock.calls.length, 0);
});

test("every request counts http.requests by method, route template and status", async () => {
  setDuration(20);
  const app = createApp({ responseSize: 100, status: 201 });
  await app.request("/v1/workspaces/workspace-1/test");
  await app.request("/v1/workspaces/workspace-2/test");
  await app.request("/v1/workspaces/workspace-3/missing");

  const counters = metrics.snapshot().counters;
  // Both workspace ids collapse onto the template; the raw path never appears.
  assert.equal(
    counters["http.requests{method=GET,route=/v1/workspaces/:workspaceId/test,status=201}"],
    2,
  );
  assert.equal(
    counters["http.requests{method=GET,route=/v1/workspaces/:workspaceId/*,status=404}"],
    1,
  );
  for (const key of Object.keys(counters)) {
    assert.ok(!key.includes("workspace-1"), `raw path leaked into ${key}`);
  }
  assert.equal(mocks.info.mock.calls.length, 0);
});

test("server failures retain WARN and the explicit threshold reason", async () => {
  setDuration(20);
  await createApp({ responseSize: 700, status: 500 }).request(
    "/v1/workspaces/workspace-1/test",
  );

  assert.equal(mocks.info.mock.calls.length, 0);
  assert.deepEqual(mocks.warn.mock.calls[0]?.[1]?.thresholdsExceeded, [
    "large_response",
  ]);
});
