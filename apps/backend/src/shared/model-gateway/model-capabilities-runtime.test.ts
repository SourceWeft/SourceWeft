import assert from "node:assert/strict";
import { test } from "vitest";
import type { ModelCapabilityRule } from "@sourceweft/model-gateway";
import { buildRoutedModelGatewayConfig } from "./runtime";
import { MODEL_CAPABILITY_DB } from "./model-capability-db";

test("the shipped DB is present with no deployment rules", () => {
  // The point of the code DB: it applies without any config declaration.
  const built = buildRoutedModelGatewayConfig({
    versionId: "v",
    providers: {},
    modelRoutes: {},
  });
  assert.deepEqual(built.modelCapabilities, [...MODEL_CAPABILITY_DB]);
});

test("deployment rules merge ahead of the shipped DB", () => {
  // Order matters: resolveModelCapabilities (package) is first-match-wins, so a
  // deployment rule placed ahead of the DB overrides it.
  const rule: ModelCapabilityRule = {
    modelMatch: "deepseek-v4-pro",
    capabilities: { disabledParams: { tool_choice: null } },
  };
  const built = buildRoutedModelGatewayConfig({
    versionId: "v",
    providers: {},
    modelRoutes: {},
    modelCapabilities: [rule],
  });
  assert.deepEqual(built.modelCapabilities, [rule, ...MODEL_CAPABILITY_DB]);
});
