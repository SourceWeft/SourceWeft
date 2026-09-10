import { afterEach, beforeEach, expect, test, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  for (const name of [
    "SOURCEWEFT_EDITION",
    "SOURCEWEFT_SAAS_ENABLED",
    "BACKEND_TEAM_BILLING_ENABLED",
    "BACKEND_BILLING_RECONCILE_ENABLED",
    "BACKEND_CREDITS_ENABLED",
    "BACKEND_PAGES_ENABLED",
    "BACKEND_BILLING_MODE",
    "BACKEND_BILLING_PROVIDER",
  ])
    vi.stubEnv(name, undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock("./commercial");
  vi.resetModules();
});

test("disabled runtime does not import commercial SDKs or initialize commercial hooks", async () => {
  vi.stubEnv("SOURCEWEFT_COMMERCIAL_ENABLED", "false");
  const load = vi.fn(() => {
    throw new Error("Commercial module must not load");
  });
  vi.doMock("./commercial", load);
  const host = await import("./bindings");
  expect(load).not.toHaveBeenCalled();
  expect(host.billingSchedulesEnabled).toBe(false);
  expect(host.getBillingAuthPlugins("runtime")).toEqual([]);
  expect(host.getBillingDeploymentCapabilities().billing.available).toBe(false);
});
test("enabled runtime import failures propagate instead of falling back to unmetered core", async () => {
  vi.stubEnv("SOURCEWEFT_COMMERCIAL_ENABLED", "true");
  vi.doMock("./commercial", () => {
    throw new Error("Selected commercial module failed");
  });
  await expect(import("./bindings")).rejects.toThrow();
});
test("enabled runtime selects the commercial adapter", async () => {
  vi.stubEnv("SOURCEWEFT_COMMERCIAL_ENABLED", "true");
  const marker = { selected: "commercial" };
  vi.doMock("./commercial", async () => ({
    ...(await import("./disabled")),
    billingRuntime: marker,
    billingSchedulesEnabled: true,
  }));
  const host = await import("./bindings");
  expect(host.billingRuntime).toBe(marker);
  expect(host.billingSchedulesEnabled).toBe(true);
});
