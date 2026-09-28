import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "vitest";
import {
  createCreemClient,
  verifyCreemSignature,
} from "../src/server/providers/creem-client";

const secret = "creem-fixture-signing-secret";
const rawBody = JSON.stringify({ id: "evt_test", eventType: "refund.created" });

function flipOneChar(hex: string) {
  const target = hex[0] === "0" ? "1" : "0";
  return `${target}${hex.slice(1)}`;
}

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
});

test("createCreemClient targets the test or live API host", () => {
  const testClient = createCreemClient({
    apiKey: "creem_test_key",
    testMode: true,
  });
  assert.equal(
    (testClient as unknown as { _options: { serverURL?: string } })._options
      .serverURL,
    "https://test-api.creem.io",
  );

  const liveClient = createCreemClient({
    apiKey: "creem_live_key",
    testMode: false,
  });
  assert.equal(
    (liveClient as unknown as { _options: { serverURL?: string } })._options
      .serverURL,
    "https://api.creem.io",
  );
});
