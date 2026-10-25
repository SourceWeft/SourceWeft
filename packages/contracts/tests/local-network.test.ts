import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_LOCAL_NETWORK_MODE,
  localNetworkModeSchema,
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
