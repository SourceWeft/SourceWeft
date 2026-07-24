import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";

const mockResolveAccess = vi.fn();
const mockCanAdministerContent = vi.fn();
const mockFindWorkspaceInOrg = vi.fn();
const mockCreateInvite = vi.fn();
const mockFindLiveInvite = vi.fn();
const mockAccept = vi.fn();

vi.mock("./service", () => ({
  workspaceService: {
    resolveAccess: (...a: unknown[]) => mockResolveAccess(...a),
    canAdministerContent: (...a: unknown[]) => mockCanAdministerContent(...a),
    findWorkspaceInOrganization: (...a: unknown[]) =>
      mockFindWorkspaceInOrg(...a),
  },
}));
vi.mock("../team-audit", () => ({ teamAuditService: { record: vi.fn() } }));
vi.mock("../../shared/config", () => ({
  config: { auth: { webBaseUrl: "https://app.test" } },
}));
vi.mock("../../shared/logger", () => ({ logger: { error: vi.fn() } }));
vi.mock("./guest-store", () => ({
  createGuestInvitationRecord: (...a: unknown[]) => mockCreateInvite(...a),
  findLiveGuestInvitationByToken: (...a: unknown[]) => mockFindLiveInvite(...a),
  acceptGuestInvitationRecord: (...a: unknown[]) => mockAccept(...a),
  listPendingGuestInvitations: vi.fn(),
  listWorkspaceGuests: vi.fn(),
  removeGuestMembership: vi.fn(),
  revokePendingGuestInvitation: vi.fn(),
}));
vi.mock("../mail", () => ({
  mailService: { sendTemplate: vi.fn().mockResolvedValue(undefined) },
}));

const { guestService } = await import("./guest-service");

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveAccess.mockResolvedValue({
    organizationId: "team-1",
    role: "workspace_admin",
    isContainerAdmin: false,
  });
  mockCanAdministerContent.mockReturnValue(true);
});

test("a workspace admin may invite a guest", async () => {
  mockFindWorkspaceInOrg.mockResolvedValue({ id: "ws-1", name: "Project X" });
  mockCreateInvite.mockResolvedValue({ email: "guest@x.com", token: "tok" });

  const result = await guestService.inviteGuest({
    workspaceId: "ws-1",
    actorUserId: "admin",
    email: "guest@x.com",
    role: "editor",
  });

  assert.equal(result.ok, true);
});

test("a non-admin member cannot invite a guest", async () => {
  mockCanAdministerContent.mockReturnValue(false);

  const result = await guestService.inviteGuest({
    workspaceId: "ws-1",
    actorUserId: "member",
    email: "guest@x.com",
    role: "editor",
  });

  assert.deepEqual(result, { ok: false, reason: "forbidden" });
});

test("inviting still succeeds when the email fails to send", async () => {
  mockFindWorkspaceInOrg.mockResolvedValue({ id: "ws-1", name: "Project X" });
  mockCreateInvite.mockResolvedValue({ email: "guest@x.com", token: "tok" });
  const mail = await import("../mail");
  (mail.mailService.sendTemplate as ReturnType<typeof vi.fn>).mockRejectedValue(
    new Error("smtp down"),
  );

  const result = await guestService.inviteGuest({
    workspaceId: "ws-1",
    actorUserId: "admin",
    email: "guest@x.com",
    role: "viewer",
  });

  assert.equal(result.ok, true);
});

test("accepting an unknown or expired token is rejected", async () => {
  mockFindLiveInvite.mockResolvedValue(null);

  const result = await guestService.acceptInvitation({
    token: "gone",
    userId: "u-1",
  });

  assert.deepEqual(result, { ok: false, reason: "invalid_invitation" });
});

test("accepting a live invitation grants access and returns the workspace", async () => {
  mockFindLiveInvite.mockResolvedValue({
    id: "inv-1",
    workspaceId: "ws-1",
    role: "editor",
  });
  mockAccept.mockResolvedValue({
    workspaceId: "ws-1",
    organizationId: "team-1",
  });

  const result = await guestService.acceptInvitation({
    token: "tok",
    userId: "guest-user",
  });

  assert.deepEqual(result, { ok: true, value: { workspaceId: "ws-1" } });
});
