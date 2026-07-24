import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";

// The service module reaches for the database through "./store" at import time,
// and touches team-audit / organization-metadata from other methods. None of
// that is exercised here — resolveBillingOrganizationId only calls the two
// methods we stub below — so the modules are stubbed just to keep the import
// graph free of a live database.
vi.mock("./store", () => ({}));
vi.mock("../team-audit", () => ({
  teamAuditService: { record: vi.fn() },
}));
vi.mock("../auth/organization-metadata", () => ({
  isPersonalOrganizationMetadata: () => false,
}));

const { WorkspaceService } = await import("./service");

const service = new WorkspaceService();

// The shared setup restores all mocks after every test, so the spies are
// re-established per test rather than once at module load.
let mockResolveAccess: ReturnType<typeof vi.spyOn>;
let mockFindPersonalOrg: ReturnType<typeof vi.spyOn>;

function access(source: "guest" | "derived" | "explicit" | null) {
  return {
    workspaceId: "ws-1",
    organizationId: "team-host",
    userId: "actor",
    organizationRole: "member",
    role: "editor" as const,
    source,
    isContainerAdmin: false,
  };
}

const INPUT = {
  workspaceId: "ws-1",
  userId: "actor",
  workspaceOrganizationId: "team-host",
};

beforeEach(() => {
  mockResolveAccess = vi.spyOn(service, "resolveAccess");
  mockFindPersonalOrg = vi.spyOn(
    service,
    "findPersonalOrganizationMembershipByUser",
  );
});

test("a guest bills their own personal organization, not the host team", async () => {
  mockResolveAccess.mockResolvedValue(access("guest"));
  mockFindPersonalOrg.mockResolvedValue({
    organizationId: "org-actor-personal",
  } as never);

  const teamId = await service.resolveBillingOrganizationId(INPUT);

  assert.equal(teamId, "org-actor-personal");
});

test("a derived member bills the workspace's org", async () => {
  mockResolveAccess.mockResolvedValue(access("derived"));

  const teamId = await service.resolveBillingOrganizationId(INPUT);

  assert.equal(teamId, "team-host");
  assert.equal(mockFindPersonalOrg.mock.calls.length, 0);
});

test("an explicit member bills the workspace's org", async () => {
  mockResolveAccess.mockResolvedValue(access("explicit"));

  const teamId = await service.resolveBillingOrganizationId(INPUT);

  assert.equal(teamId, "team-host");
  assert.equal(mockFindPersonalOrg.mock.calls.length, 0);
});

test("a guest with no personal org falls back to the workspace's org", async () => {
  mockResolveAccess.mockResolvedValue(access("guest"));
  mockFindPersonalOrg.mockResolvedValue(null);

  const teamId = await service.resolveBillingOrganizationId(INPUT);

  assert.equal(teamId, "team-host");
});

test("no access at all bills the workspace's org", async () => {
  mockResolveAccess.mockResolvedValue(null);

  const teamId = await service.resolveBillingOrganizationId(INPUT);

  assert.equal(teamId, "team-host");
});
