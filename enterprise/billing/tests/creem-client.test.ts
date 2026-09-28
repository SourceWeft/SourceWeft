import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { afterEach, test, vi } from "vitest";
import {
  createCreemClient,
  createCreemPortalLink,
  verifyCreemSignature,
} from "../src/server/providers/creem-client";
import { BillingError } from "../src/server/errors";

const secret = "creem-fixture-signing-secret";
const rawBody = JSON.stringify({ id: "evt_test", eventType: "refund.created" });

function flipOneChar(hex: string) {
  const target = hex[0] === "0" ? "1" : "0";
  return `${target}${hex.slice(1)}`;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test("verifyCreemSignature accepts the correct HMAC in any hex case and rejects everything else", () => {
  const correct = createHmac("sha256", secret).update(rawBody).digest("hex");

  assert.equal(verifyCreemSignature(rawBody, correct, secret), true);
  assert.equal(
    verifyCreemSignature(rawBody, correct.toUpperCase(), secret),
    true,
  );
  assert.equal(verifyCreemSignature(rawBody, `  ${correct}  `, secret), true);
  assert.equal(
    verifyCreemSignature(rawBody, flipOneChar(correct), secret),
    false,
  );
  assert.equal(verifyCreemSignature(rawBody, null, secret), false);
  assert.equal(verifyCreemSignature(rawBody, "", secret), false);
  assert.equal(
    verifyCreemSignature(rawBody, correct.slice(0, -1), secret),
    false,
  );
  // An empty secret must fail closed. Node's createHmac("sha256", "") still
  // succeeds and produces a real digest (unlike the old WebCrypto-based
  // path, which threw on an empty key), so this has to be checked
  // explicitly rather than relying on the HMAC call to reject it.
  assert.equal(verifyCreemSignature(rawBody, correct, ""), false);
  assert.equal(
    verifyCreemSignature(
      rawBody,
      createHmac("sha256", "").update(rawBody).digest("hex"),
      "",
    ),
    false,
  );
});

test("createCreemClient targets the test or live API host", async () => {
  const seenOrigins: string[] = [];
  vi.stubGlobal("fetch", async (request: Request) => {
    seenOrigins.push(new URL(request.url).origin);
    return jsonResponse({ customer_portal_link: "https://portal.example/x" });
  });

  await createCreemClient({
    apiKey: "creem_test_key",
    testMode: true,
  }).customers.generateBillingLinks({ customerId: "cust_1" });

  await createCreemClient({
    apiKey: "creem_live_key",
    testMode: false,
  }).customers.generateBillingLinks({ customerId: "cust_1" });

  assert.deepEqual(seenOrigins, [
    "https://test-api.creem.io",
    "https://api.creem.io",
  ]);
});

test("createCreemPortalLink returns the link from the test host", async () => {
  const requests: { url: string; method: string }[] = [];
  vi.stubGlobal("fetch", async (request: Request) => {
    requests.push({ url: request.url, method: request.method });
    return jsonResponse({
      customer_portal_link: "https://test-api.creem.io/portal/cust_1",
    });
  });

  const url = await createCreemPortalLink(
    { apiKey: "creem_test_key", testMode: true },
    "cust_1",
  );

  assert.equal(url, "https://test-api.creem.io/portal/cust_1");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.method, "POST");
  assert.equal(
    requests[0]?.url,
    "https://test-api.creem.io/v1/customers/billing",
  );
});

test("createCreemPortalLink throws CREEM_PORTAL_UNAVAILABLE when Creem returns no link", async () => {
  vi.stubGlobal("fetch", async () =>
    jsonResponse({ customer_portal_link: "" }),
  );

  await assert.rejects(
    () =>
      createCreemPortalLink(
        { apiKey: "creem_test_key", testMode: true },
        "cust_1",
      ),
    (error: unknown) => {
      assert.ok(error instanceof BillingError);
      assert.equal(error.code, "CREEM_PORTAL_UNAVAILABLE");
      assert.equal(error.statusCode, 502);
      return true;
    },
  );
});
