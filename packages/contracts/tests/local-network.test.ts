import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_LOCAL_NETWORK_MODE,
  localNetworkModeSchema,
  localNetworkRequestSchema,
  respondLocalNetworkRequestSchema,
  updateLocalDeviceNetworkModeSchema,
} from "../src/local-network";
import { toolConfirmationDomainSchema } from "../src/agent-confirmations";

test("modes are the three device policies and ask is the default", () => {
  assert.deepEqual(localNetworkModeSchema.options, ["open", "ask", "strict"]);
  assert.equal(DEFAULT_LOCAL_NETWORK_MODE, "ask");
  assert.equal(
    updateLocalDeviceNetworkModeSchema.safeParse({ networkMode: "any" })
      .success,
    false,
  );
});

test("a response carries only the decision and a TTL, never the rule subject", () => {
  assert.deepEqual(
    respondLocalNetworkRequestSchema.parse({
      decision: "allow_always",
      trust: { ttlSeconds: 3600 },
    }),
    { decision: "allow_always", trust: { ttlSeconds: 3600 } },
  );
  for (const body of [
    { decision: "approve" },
    { decision: "allow_always", trust: { host: "evil.example" } },
    { decision: "deny", host: "evil.example" },
    { decision: "allow_always", trust: { ttlSeconds: 0 } },
    { decision: "allow_always", trust: { ttlSeconds: 91 * 24 * 60 * 60 } },
  ])
    assert.equal(
      respondLocalNetworkRequestSchema.safeParse(body).success,
      false,
      JSON.stringify(body),
    );
});

test("network is a confirmation domain", () => {
  assert.equal(toolConfirmationDomainSchema.safeParse("network").success, true);
});

test("a pending request may be a write request with method and path, and old shapes still parse", () => {
  const base = {
    id: "r",
    host: "api.example.com",
    port: 443,
    commandPreview: "curl -X POST",
    suggestedBy: null,
    createdAt: "2026-10-25T00:00:00.000Z",
    expiresAt: "2026-10-25T00:02:00.000Z",
  };
  assert.deepEqual(localNetworkRequestSchema.parse(base), base);
  const write = {
    ...base,
    kind: "request",
    method: "POST",
    path: "/v1/items",
    secretInBody: true,
  };
  assert.deepEqual(localNetworkRequestSchema.parse(write), write);
  for (const bad of [
    { ...base, kind: "rule" },
    { ...base, kind: "request", method: "POST", secretInBody: "yes" },
    { ...base, kind: "request", method: "P".repeat(17) },
    { ...base, kind: "request", method: "POST", path: "/".repeat(201) },
  ])
    assert.equal(localNetworkRequestSchema.safeParse(bad).success, false);
});
