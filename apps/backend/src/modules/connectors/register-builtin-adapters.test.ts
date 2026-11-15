import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";

const collect = vi.hoisted(() => vi.fn());
const register = vi.hoisted(() => vi.fn());

vi.mock("../capabilities/host-services", () => ({
  collectCapabilityConnectorContributions: collect,
}));
vi.mock("./registry", () => ({ connectorRegistry: { register } }));
vi.mock("@sourceweft/agent-tool-registry", () => ({
  registerAgentTools: vi.fn(),
}));

beforeEach(() => {
  vi.resetModules();
  collect.mockReset();
  register.mockReset();
});

async function load() {
  return import("./register-builtin-adapters");
}

test("a malformed connector setting rejects registration, so the awaiting entrypoint stops", async () => {
  collect.mockRejectedValueOnce(
    new Error("GOOGLE_DRIVE_CONNECTOR_ENABLED must be true, false, 1, or 0"),
  );
  const { connectorAdaptersReady } = await load();

  await assert.rejects(
    connectorAdaptersReady(),
    /GOOGLE_DRIVE_CONNECTOR_ENABLED must be true, false, 1, or 0/,
  );
  assert.equal(register.mock.calls.length, 0);
});

test("a failed registration is not cached; the next call tries again", async () => {
  const adapter = { capabilityId: "synthetic" };
  collect
    .mockRejectedValueOnce(new Error("transient"))
    .mockResolvedValueOnce({ adapters: [adapter], agentToolDefs: [] });
  const { connectorAdaptersReady } = await load();

  await assert.rejects(connectorAdaptersReady(), /transient/);
  await connectorAdaptersReady();

  assert.equal(collect.mock.calls.length, 2);
  assert.deepEqual(register.mock.calls, [[adapter]]);
});

test("a successful registration runs once and registers every adapter", async () => {
  const adapters = [{ capabilityId: "a" }, { capabilityId: "b" }];
  collect.mockResolvedValue({ adapters, agentToolDefs: [] });
  const { connectorAdaptersReady } = await load();

  await connectorAdaptersReady();
  await connectorAdaptersReady();

  assert.equal(collect.mock.calls.length, 1);
  assert.deepEqual(register.mock.calls, [[adapters[0]], [adapters[1]]]);
});
