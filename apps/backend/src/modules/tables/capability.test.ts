import assert from "node:assert/strict";
import { TableCapabilityUnavailableError } from "@sourceweft/contracts/table-capability";
import { test, vi } from "vitest";
import { loadTableGeneration, TABLE_CAPABILITY_PACKAGE } from "./capability";

test("the real table package loads through the registry with its generation members", async () => {
  const generation = await loadTableGeneration();
  assert.equal(typeof generation.suggestColumns, "function");
  assert.equal(typeof generation.resolveColumns, "function");
  assert.equal(typeof generation.planFill, "function");
  assert.equal(typeof generation.fillTable, "function");
  assert.ok(generation.limits.maxTotalInputTokens > 0);
  assert.ok(generation.limits.jobTimeoutMs > 0);
});

test("a package missing from the module table is a deployment fault", async () => {
  const loader = vi.fn(() => undefined);
  await assert.rejects(loadTableGeneration(loader), TableCapabilityUnavailableError);
  assert.deepEqual(loader.mock.calls, [[TABLE_CAPABILITY_PACKAGE]]);
});

test("an entry without the factory, or without generation members, fails loudly", async () => {
  await assert.rejects(
    loadTableGeneration(() => async () => ({})),
    TableCapabilityUnavailableError,
  );
  await assert.rejects(
    loadTableGeneration(() => async () => ({ createTableCapability: () => ({}) })),
    /"generation"/,
  );
  await assert.rejects(
    loadTableGeneration(() => async () => ({
      createTableCapability: () => ({ generation: { suggestColumns: () => [] } }),
    })),
    /fillTable/,
  );
});
