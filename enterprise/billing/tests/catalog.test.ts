import assert from "node:assert/strict";
import { test } from "vitest";
import { validateBillingCatalog } from "../src/server/catalog";
import { runtimeConfig } from "./test-fixtures";

test("catalog validation catches missing active provider product", async () => {
  assert.throws(
    () =>
      validateBillingCatalog({
        runtimeConfig: {
          ...runtimeConfig,
          saasEnabled: true,
          provider: "creem",
          creem: {
            ...runtimeConfig.creem,
            teamStandardYearlyProductId: "",
          },
        },
      }),
    (error: unknown) => {
      assert.equal(
        (error as { code?: string }).code,
        "BILLING_CATALOG_INVALID",
      );
      return true;
    },
  );
});
