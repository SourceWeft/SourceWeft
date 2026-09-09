import assert from "node:assert/strict";
import { test } from "vitest";
import {
  readBillingConfig,
  validateBillingConfiguration,
} from "../src/server/config";
test("billing defaults do not depend on the developer environment or a credential being present", () => {
  const config = readBillingConfig(
    { CREEM_API_KEY: "test-only-credential" },
    "http://localhost:3000",
  );
  assert.equal(config.provider, "none");
  assert.equal(config.saasEnabled, false);
  assert.equal(config.defaultMonthlyCredits, 3000);
  assert.equal(config.creditUnitUsd, 0.00125);
});
test("invalid modes and explicitly unsupported checkout providers fail rather than silently disabling billing", () => {
  assert.throws(() =>
    readBillingConfig(
      { BACKEND_BILLING_MODE: "typo" },
      "http://localhost:3000",
    ),
  );
  assert.throws(
    () =>
      readBillingConfig(
        { SOURCEWEFT_SAAS_ENABLED: "true", BACKEND_BILLING_PROVIDER: "stripe" },
        "http://localhost:3000",
      ),
    /not supported/,
  );
  assert.throws(() =>
    readBillingConfig(
      { BACKEND_CREDIT_UNIT_USD: "-1" },
      "http://localhost:3000",
    ),
  );
});
test("enabled checkout requires credentials, while disabled checkout can run the ledger", () => {
  validateBillingConfiguration(readBillingConfig({}, "http://localhost:3000"));
  assert.throws(
    () =>
      validateBillingConfiguration(
        readBillingConfig(
          {
            SOURCEWEFT_SAAS_ENABLED: "true",
            BACKEND_BILLING_PROVIDER: "creem",
          },
          "http://localhost:3000",
        ),
      ),
    /CREEM_API_KEY/,
  );
});
