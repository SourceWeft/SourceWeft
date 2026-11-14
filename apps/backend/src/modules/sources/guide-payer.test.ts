import assert from "node:assert/strict";
import { test } from "vitest";
import { resolveGuidePayer, type GuidePayerPorts } from "./guide-payer";

const access = {} as never;

function ports(overrides: Partial<GuidePayerPorts> = {}): GuidePayerPorts {
  return {
    resolveAccess: async () => access,
    resolveResponsibleUserId: async () => "owner-1",
    resolveBillingOrganizationId: async (input) =>
      input.workspaceOrganizationId,
    ...overrides,
  };
}

const base = { workspaceId: "w1", organizationId: "team-1" };

test("the person who added the source pays", async () => {
  const payer = await resolveGuidePayer(
    { ...base, initiatorUserId: "uploader" },
    ports(),
  );
  assert.deepEqual(payer, {
    userId: "uploader",
    billingOrganizationId: "team-1",
  });
});

test("with nobody in the loop the workspace's responsible owner pays", async () => {
  const payer = await resolveGuidePayer(
    { ...base, initiatorUserId: null },
    ports(),
  );
  assert.equal(payer?.userId, "owner-1");
});

test("someone who lost access to the workspace is not charged, and nobody replaces them", async () => {
  let askedOwner = false;
  const payer = await resolveGuidePayer(
    { ...base, initiatorUserId: "gone" },
    ports({
      resolveAccess: async ({ userId }) => (userId === "gone" ? null : access),
      resolveResponsibleUserId: async () => {
        askedOwner = true;
        return "owner-1";
      },
    }),
  );
  assert.equal(payer, null);
  assert.equal(askedOwner, false);
});

test("a system run with no responsible owner has no payer", async () => {
  const payer = await resolveGuidePayer(
    { ...base },
    ports({ resolveResponsibleUserId: async () => null }),
  );
  assert.equal(payer, null);
});

test("a guest is settled against their own organization", async () => {
  const payer = await resolveGuidePayer(
    { ...base, initiatorUserId: "guest-1" },
    ports({ resolveBillingOrganizationId: async () => "guest-personal-org" }),
  );
  assert.deepEqual(payer, {
    userId: "guest-1",
    billingOrganizationId: "guest-personal-org",
  });
});
