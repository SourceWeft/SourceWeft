import assert from "node:assert/strict";
import test from "node:test";
import {
  respondAgentConfirmationRequestSchema,
  toolConfirmationDecisionSchema,
  toolTrustRuleScopeSchema,
} from "../src/agent-confirmations";

test("approve_always joins the original decisions", () => {
  assert.deepEqual(toolConfirmationDecisionSchema.options, [
    "approve",
    "reject",
    "approve_always",
  ]);
  assert.equal(toolConfirmationDecisionSchema.safeParse("allow").success, false);
});

test("the trust payload carries only granularity and TTL", () => {
  const parsed = respondAgentConfirmationRequestSchema.parse({
    decision: "approve_always",
    trust: { scope: "tool", ttlSeconds: 3600 },
  });
  assert.deepEqual(parsed.trust, { scope: "tool", ttlSeconds: 3600 });
});

test("a client cannot name the subject of the grant it is asking for", () => {
  const parsed = respondAgentConfirmationRequestSchema.parse({
    decision: "approve_always",
    trust: {
      scope: "tool",
      toolName: "gmail_delete_email",
      connectorId: "connector-9",
      allowedRiskLevels: ["high"],
    },
  });
  assert.deepEqual(parsed.trust, { scope: "tool" });
});

test("TTL is bounded on the wire", () => {
  assert.equal(
    respondAgentConfirmationRequestSchema.safeParse({
      decision: "approve_always",
      trust: { ttlSeconds: 91 * 24 * 60 * 60 },
    }).success,
    false,
  );
  assert.equal(
    respondAgentConfirmationRequestSchema.safeParse({
      decision: "approve_always",
      trust: { ttlSeconds: 0 },
    }).success,
    false,
  );
});

test("existing approve/reject payloads are unchanged", () => {
  assert.equal(
    respondAgentConfirmationRequestSchema.parse({ decision: "approve" }).trust,
    undefined,
  );
});

test("only scopes the trust rule query can match are offered", () => {
  assert.deepEqual(toolTrustRuleScopeSchema.options, ["tool", "target"]);
});
