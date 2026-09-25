import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";

const capabilities = vi.fn();
const getOrganizationMembership = vi.fn();

vi.mock("../../billing-host/bindings", () => ({
  billingRuntime: {},
  getBillingDeploymentCapabilities: () => capabilities(),
}));
vi.mock("../workspace", () => ({
  workspaceService: {
    getOrganizationMembership: (...args: unknown[]) =>
      getOrganizationMembership(...args),
  },
}));

const { resolveConnectorBillingActor } = await import("./sync-orchestrator");

beforeEach(() => {
  capabilities.mockReset();
  getOrganizationMembership.mockReset();
});

test("with commercial billing the connector owner pays whoever triggered the run", async () => {
  capabilities.mockReturnValue({ billing: { available: true } });
  getOrganizationMembership.mockResolvedValue({ userId: "owner" });
  assert.equal(
    await resolveConnectorBillingActor({
      teamId: "team",
      ownerUserId: "owner",
      triggerUserId: "system",
    }),
    "owner",
  );
  assert.deepEqual(getOrganizationMembership.mock.calls[0], [
    { organizationId: "team", userId: "owner" },
  ]);
});

test("an owner who left the team, or no owner, leaves no one to bill", async () => {
  capabilities.mockReturnValue({ billing: { available: true } });
  getOrganizationMembership.mockResolvedValue(null);
  assert.equal(
    await resolveConnectorBillingActor({
      teamId: "team",
      ownerUserId: "former",
      triggerUserId: "member",
    }),
    null,
  );
  assert.equal(
    await resolveConnectorBillingActor({
      teamId: "team",
      ownerUserId: null,
      triggerUserId: "member",
    }),
    null,
  );
});

test("without commercial billing the actor is attribution only", async () => {
  capabilities.mockReturnValue({ billing: { available: false } });
  assert.equal(
    await resolveConnectorBillingActor({
      teamId: "team",
      ownerUserId: null,
      triggerUserId: "system",
    }),
    "system",
  );
  assert.equal(getOrganizationMembership.mock.calls.length, 0);
});
