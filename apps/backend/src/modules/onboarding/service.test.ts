import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findPersonalOrganizationMembershipByUser: vi.fn(),
  createPersonalOrganization: vi.fn(),
  ensureMembershipWorkspace: vi.fn(),
  provisionAccount: vi.fn(),
  enqueueWelcomeEmail: vi.fn(),
}));

vi.mock("../workspace", () => ({
  workspaceService: {
    findPersonalOrganizationMembershipByUser:
      mocks.findPersonalOrganizationMembershipByUser,
    createPersonalOrganization: mocks.createPersonalOrganization,
    ensureMembershipWorkspace: mocks.ensureMembershipWorkspace,
  },
}));

vi.mock("../../billing-host/bindings", () => ({
  billingOrganizationHooks: {
    provisionAccount: mocks.provisionAccount,
  },
}));

vi.mock("./welcome-email", () => ({
  enqueueWelcomeEmail: mocks.enqueueWelcomeEmail,
}));

import { onboardingService } from "./service";

beforeEach(() => {
  mocks.findPersonalOrganizationMembershipByUser.mockReset();
  mocks.createPersonalOrganization.mockReset();
  mocks.ensureMembershipWorkspace.mockReset();
  mocks.provisionAccount.mockReset();
  mocks.enqueueWelcomeEmail.mockReset();

  mocks.ensureMembershipWorkspace.mockResolvedValue(undefined);
  mocks.provisionAccount.mockResolvedValue(undefined);
  mocks.enqueueWelcomeEmail.mockResolvedValue(undefined);
});

test("enqueues the welcome email when this session created the personal workspace", async () => {
  const headers = new Headers();
  mocks.findPersonalOrganizationMembershipByUser.mockResolvedValue(null);
  mocks.createPersonalOrganization.mockResolvedValue({
    created: true,
    id: "org1",
  });

  await onboardingService.handleSessionCreated({ userId: "u1", headers });

  assert.deepEqual(mocks.enqueueWelcomeEmail.mock.calls, [
    [{ userId: "u1", headers }],
  ]);
  assert.equal(mocks.provisionAccount.mock.calls.length, 1);
  assert.deepEqual(mocks.provisionAccount.mock.calls[0], ["org1", "u1"]);
});

test("does not enqueue for a user who already has a personal workspace", async () => {
  mocks.findPersonalOrganizationMembershipByUser.mockResolvedValue({
    organizationId: "org1",
  });

  await onboardingService.handleSessionCreated({ userId: "u1" });

  assert.equal(mocks.enqueueWelcomeEmail.mock.calls.length, 0);
  assert.equal(mocks.createPersonalOrganization.mock.calls.length, 0);
  assert.equal(mocks.provisionAccount.mock.calls.length, 0);
});

test("does not enqueue when a concurrent session created the workspace first", async () => {
  mocks.findPersonalOrganizationMembershipByUser.mockResolvedValue(null);
  mocks.createPersonalOrganization.mockResolvedValue({
    created: false,
    id: "org1",
  });

  await onboardingService.handleSessionCreated({ userId: "u1" });

  assert.equal(mocks.enqueueWelcomeEmail.mock.calls.length, 0);
  assert.equal(mocks.provisionAccount.mock.calls.length, 0);
});

test("does not wait on the welcome email queue before resolving", async () => {
  const headers = new Headers();
  mocks.findPersonalOrganizationMembershipByUser.mockResolvedValue(null);
  mocks.createPersonalOrganization.mockResolvedValue({
    created: true,
    id: "org1",
  });
  // enqueueWelcomeEmail never rejects by contract; here it never even
  // settles, simulating a Redis outage hanging the queue add. The sign-in
  // hook must still resolve without waiting on it.
  mocks.enqueueWelcomeEmail.mockReturnValue(new Promise(() => {}));

  await onboardingService.handleSessionCreated({ userId: "u1", headers });

  assert.deepEqual(mocks.enqueueWelcomeEmail.mock.calls, [
    [{ userId: "u1", headers }],
  ]);
});

test("still rejects when provisioning fails, and enqueues nothing", async () => {
  mocks.findPersonalOrganizationMembershipByUser.mockResolvedValue(null);
  mocks.createPersonalOrganization.mockResolvedValue({
    created: true,
    id: "org1",
  });
  mocks.provisionAccount.mockRejectedValue(new Error("billing down"));

  await assert.rejects(
    onboardingService.handleSessionCreated({ userId: "u1" }),
    /billing down/,
  );

  assert.equal(mocks.enqueueWelcomeEmail.mock.calls.length, 0);
});
