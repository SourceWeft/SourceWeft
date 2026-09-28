// Entry-point ordering for the Creem webhook handler: every POST to the
// webhook path on a Creem deployment must be answered directly (never
// `null`, which apps/backend/src/api/app.ts would otherwise hand to Better
// Auth, which 404s). These tests exercise `createCreemWebhookHandler`'s own
// ordering — signature verification, then event-type dispatch, then the
// refund/dispute reversal dispatch — in isolation from the rest of the
// billing stack.
import assert from "node:assert/strict";
import { test } from "vitest";
import { createHmac } from "node:crypto";
import { createCreemWebhookHandler } from "../src/server/providers/creem-webhook-bypass";
import { runtimeConfig } from "./test-fixtures";

const WEBHOOK_URL = "http://localhost/api/auth/creem/webhook";

function fixture(
  overrides: {
    webhookSecret?: string;
    reversalSync?: (...args: unknown[]) => Promise<void>;
  } = {},
) {
  const config = {
    ...runtimeConfig,
    saasEnabled: true,
    provider: "creem" as const,
    creem: {
      ...runtimeConfig.creem,
      webhookSecret: overrides.webhookSecret ?? "creem-fixture-signing-secret",
    },
  };
  const syncCalls: unknown[][] = [];
  const reversalCalls: unknown[][] = [];
  const warnCalls: { message: string; fields?: Record<string, unknown> }[] = [];
  const handler = createCreemWebhookHandler({
    config,
    logger: {
      info() {},
      warn(message, fields) {
        warnCalls.push({ message, fields });
      },
      error() {},
    },
    sync: async (...args: unknown[]) => {
      syncCalls.push(args);
    },
    reversalSync:
      overrides.reversalSync ??
      (async (...args: unknown[]) => {
        reversalCalls.push(args);
      }),
  });
  return { config, handler, syncCalls, reversalCalls, warnCalls };
}

function sign(raw: string, secret = "creem-fixture-signing-secret") {
  return createHmac("sha256", secret).update(raw).digest("hex");
}

function post(body: string, signature?: string) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (signature !== undefined) headers["creem-signature"] = signature;
  return new Request(WEBHOOK_URL, { method: "POST", headers, body });
}

test("malformed and non-object bodies are rejected, never passed to Better Auth", async () => {
  const f = fixture();
  for (const body of ["{", "[]", "null", "42"]) {
    const response = await f.handler(post(body));
    assert.notEqual(response, null);
    assert.equal(response?.status, 400);
  }
});

test("unsigned or wrongly signed deliveries are rejected before the type is read", async () => {
  const f = fixture();
  const raw = JSON.stringify({
    id: "evt_1",
    eventType: "credits.granted",
    object: {},
  });

  const unsigned = await f.handler(post(raw));
  assert.equal(unsigned?.status, 400);

  const wronglySigned = await f.handler(post(raw, "invalid"));
  assert.equal(wronglySigned?.status, 400);

  const refundRaw = JSON.stringify({
    id: "evt_refund_0",
    eventType: "refund.created",
    object: { id: "ref_0", mode: "test", status: "succeeded" },
  });

  const unsignedRefund = await f.handler(post(refundRaw));
  assert.equal(unsignedRefund?.status, 400);

  const wronglySignedRefund = await f.handler(post(refundRaw, "invalid"));
  assert.equal(wronglySignedRefund?.status, 400);

  assert.equal(f.syncCalls.length, 0);
  assert.equal(f.reversalCalls.length, 0);
});

test("signed envelope without a string eventType is rejected", async () => {
  const f = fixture();
  const missing = JSON.stringify({ id: "evt_1", object: {} });
  const missingResponse = await f.handler(post(missing, sign(missing)));
  assert.equal(missingResponse?.status, 400);

  const nonString = JSON.stringify({
    id: "evt_1",
    eventType: 42,
    object: {},
  });
  const nonStringResponse = await f.handler(post(nonString, sign(nonString)));
  assert.equal(nonStringResponse?.status, 400);
});

test("signed unsupported types are acknowledged without a mode check", async () => {
  const f = fixture();
  const raw = JSON.stringify({
    id: "evt_1",
    eventType: "credits.granted",
    object: {},
  });
  const response = await f.handler(post(raw, sign(raw)));
  assert.equal(response?.status, 200);
  assert.equal(f.syncCalls.length, 0);
  assert.equal(f.reversalCalls.length, 0);
});

test("signed refund and dispute events are dispatched to the reversal sync", async () => {
  const f = fixture();

  const refundRaw = JSON.stringify({
    id: "evt_refund_1",
    eventType: "refund.created",
    object: {
      id: "ref_1",
      mode: "test",
      status: "succeeded",
      refund_amount: 500,
      refund_currency: "usd",
      transaction: "tran_123",
      order: "ord_123",
    },
  });
  const refundResponse = await f.handler(post(refundRaw, sign(refundRaw)));
  assert.equal(refundResponse?.status, 200);

  const disputeRaw = JSON.stringify({
    id: "evt_dispute_1",
    eventType: "dispute.created",
    object: {
      id: "dis_1",
      mode: "test",
      status: "disputed",
      amount: 700,
      currency: "usd",
      transaction: "tran_456",
      order: { id: "ord_456" },
    },
  });
  const disputeResponse = await f.handler(post(disputeRaw, sign(disputeRaw)));
  assert.equal(disputeResponse?.status, 200);

  assert.equal(f.reversalCalls.length, 2);
  assert.equal(f.reversalCalls[0]?.[0], "refund.created");
  assert.equal(
    (f.reversalCalls[0]?.[1] as Record<string, unknown>).id,
    "ref_1",
  );
  assert.equal(
    (f.reversalCalls[0]?.[1] as Record<string, unknown>).webhookId,
    "evt_refund_1",
  );
  assert.equal(f.reversalCalls[1]?.[0], "dispute.created");
  assert.equal(
    (f.reversalCalls[1]?.[1] as Record<string, unknown>).id,
    "dis_1",
  );

  assert.equal(f.syncCalls.length, 0);
});

test("reversal events are checked against the deployment mode before dispatching", async () => {
  const f = fixture();
  const raw = JSON.stringify({
    id: "evt_refund_3",
    eventType: "refund.created",
    object: { id: "ref_3", mode: "prod", status: "succeeded" },
  });
  const response = await f.handler(post(raw, sign(raw)));
  assert.equal(response?.status, 403);
  assert.equal(f.reversalCalls.length, 0);
  assert.equal(f.syncCalls.length, 0);
});

test("reversal sync failure returns 500 so Creem redelivers", async () => {
  const f = fixture({
    reversalSync: async () => {
      throw new Error("reversal sync unavailable");
    },
  });
  const raw = JSON.stringify({
    id: "evt_refund_2",
    eventType: "refund.created",
    object: { id: "ref_2", mode: "test", status: "succeeded" },
  });
  const response = await f.handler(post(raw, sign(raw)));
  assert.equal(response?.status, 500);
});

test("mode mismatch on a handled event is rejected", async () => {
  const f = fixture();
  const raw = JSON.stringify({
    id: "evt_2",
    eventType: "subscription.active",
    object: { mode: "prod" },
  });
  const response = await f.handler(post(raw, sign(raw)));
  assert.equal(response?.status, 403);
  assert.equal(f.syncCalls.length, 0);
});

test("mode mismatch logs the received and expected mode", async () => {
  const f = fixture();
  const raw = JSON.stringify({
    id: "evt_sandbox_1",
    eventType: "subscription.active",
    object: { mode: "sandbox" },
  });
  const response = await f.handler(post(raw, sign(raw)));
  assert.equal(response?.status, 403);
  assert.equal(f.syncCalls.length, 0);

  assert.equal(f.warnCalls.length, 1);
  assert.equal(f.warnCalls[0]?.message, "Creem webhook mode mismatch");
  assert.deepEqual(f.warnCalls[0]?.fields, {
    eventType: "subscription.active",
    webhookId: "evt_sandbox_1",
    receivedMode: "sandbox",
    expectedMode: "test",
  });
});

test("mode mismatch on a refund event logs the received and expected mode", async () => {
  const f = fixture();
  const raw = JSON.stringify({
    id: "evt_refund_sandbox_1",
    eventType: "refund.created",
    object: { id: "ref_sandbox_1", mode: "sandbox", status: "succeeded" },
  });
  const response = await f.handler(post(raw, sign(raw)));
  assert.equal(response?.status, 403);
  assert.equal(f.reversalCalls.length, 0);

  assert.equal(f.warnCalls.length, 1);
  assert.equal(f.warnCalls[0]?.message, "Creem webhook mode mismatch");
  assert.deepEqual(f.warnCalls[0]?.fields, {
    eventType: "refund.created",
    webhookId: "evt_refund_sandbox_1",
    receivedMode: "sandbox",
    expectedMode: "test",
  });
});

test("mode mismatch with no mode field logs receivedMode as null", async () => {
  const f = fixture();
  const raw = JSON.stringify({
    id: "evt_no_mode",
    eventType: "subscription.active",
    object: {},
  });
  const response = await f.handler(post(raw, sign(raw)));
  assert.equal(response?.status, 403);
  assert.equal(f.syncCalls.length, 0);

  assert.equal(f.warnCalls.length, 1);
  // pino drops `undefined` fields silently, which would hide that a mode
  // was expected at all; `null` makes the absence explicit in the log.
  assert.deepEqual(f.warnCalls[0]?.fields, {
    eventType: "subscription.active",
    webhookId: "evt_no_mode",
    receivedMode: null,
    expectedMode: "test",
  });
});

test("missing webhook secret rejects signed deliveries", async () => {
  const f = fixture({ webhookSecret: "" });
  const raw = JSON.stringify({
    id: "evt_3",
    eventType: "subscription.active",
    object: { mode: "test" },
  });
  const response = await f.handler(post(raw, sign(raw)));
  assert.equal(response?.status, 400);
});

test("a POST to the webhook path is always answered", async () => {
  const f = fixture();
  const signedUnsupported = JSON.stringify({
    id: "evt_1",
    eventType: "credits.granted",
    object: {},
  });
  for (const body of ["{", "[]", "null", "42"]) {
    assert.notEqual(await f.handler(post(body)), null);
  }
  assert.notEqual(
    await f.handler(post(signedUnsupported, sign(signedUnsupported))),
    null,
  );
});

test("other paths and providers are left to Better Auth", async () => {
  const f = fixture();
  const otherPath = await f.handler(
    new Request("http://localhost/api/auth/sign-in/email", { method: "POST" }),
  );
  assert.equal(otherPath, null);

  const stripeHandler = createCreemWebhookHandler({
    config: { ...f.config, provider: "stripe" as const },
    logger: { info() {}, warn() {}, error() {} },
    sync: async () => {},
    reversalSync: async () => {},
  });
  const stripeResult = await stripeHandler(post("{}"));
  assert.equal(stripeResult, null);
});
