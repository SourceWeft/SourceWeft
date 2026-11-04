import assert from "node:assert/strict";
import { test } from "vitest";
import {
  classifyNetworkResponseError,
  formatNetworkRemaining,
  networkRequestRemainingMs,
  visibleNetworkRequests,
} from "./network-access-state";

const request = (id: string, expiresAt: string) => ({
  id,
  host: "example.com",
  port: 443,
  commandPreview: "curl https://example.com",
  suggestedBy: null,
  createdAt: "2026-10-25T00:00:00.000Z",
  expiresAt,
});

test("resolved, expired and missing requests are gone; 403 is forbidden", () => {
  for (const code of [
    "NETWORK_REQUEST_RESOLVED",
    "NETWORK_REQUEST_EXPIRED",
    "NETWORK_REQUEST_NOT_FOUND",
  ]) {
    assert.equal(classifyNetworkResponseError({ code, status: 409 }), "gone");
  }
  assert.equal(
    classifyNetworkResponseError({ code: "CONNECTOR_FORBIDDEN", status: 403 }),
    "forbidden",
  );
  assert.equal(classifyNetworkResponseError({ status: 403 }), "forbidden");
  assert.equal(classifyNetworkResponseError(new Error("boom")), "failed");
  assert.equal(classifyNetworkResponseError(null), "failed");
});

test("remaining time formats as m:ss and never goes negative", () => {
  assert.equal(formatNetworkRemaining(105_000), "1:45");
  assert.equal(formatNetworkRemaining(1), "0:01");
  assert.equal(formatNetworkRemaining(-5_000), "0:00");
});

test("expired and unparseable deadlines are not offered", () => {
  const now = Date.parse("2026-10-25T00:01:00.000Z");
  const live = request("live", "2026-10-25T00:02:00.000Z");
  const dead = request("dead", "2026-10-25T00:00:59.000Z");
  const garbage = request("garbage", "not a date");
  assert.equal(networkRequestRemainingMs(live, now), 60_000);
  assert.deepEqual(
    visibleNetworkRequests([dead, live, garbage], now).map((r) => r.id),
    ["live"],
  );
});
