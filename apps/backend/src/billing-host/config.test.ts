import assert from "node:assert/strict";
import { test } from "vitest";
import { assertEditionConfiguration } from "./config";

test("a core build starts without any billing environment or payment credentials", () => {
  assertEditionConfiguration("core", {});
  assertEditionConfiguration("core", {
    CREEM_API_KEY: "credential-does-not-activate",
  });
  assertEditionConfiguration("core", {
    BACKEND_BILLING_MODE: "disabled",
    BACKEND_BILLING_PROVIDER: "none",
  });
});

test("explicit commercial intent cannot silently select unmetered core", () => {
  for (const env of [
    { SOURCEWEFT_EDITION: "commercial" },
    { SOURCEWEFT_EDITION: "typo" },
    { SOURCEWEFT_SAAS_ENABLED: "true" },
    { BACKEND_BILLING_MODE: "enforced" },
    { BACKEND_BILLING_PROVIDER: "creem" },
    { BACKEND_PAGES_ENABLED: "true" },
    { BACKEND_TEAM_BILLING_ENABLED: "tru" },
  ])
    assert.throws(() => assertEditionConfiguration("core", env));
});

test("a commercial build cannot be changed to core by runtime environment", () => {
  assertEditionConfiguration("commercial", {
    SOURCEWEFT_EDITION: "commercial",
  });
  assert.throws(() =>
    assertEditionConfiguration("commercial", { SOURCEWEFT_EDITION: "core" }),
  );
});
