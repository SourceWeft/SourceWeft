import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";

const mockResolveAccess = vi.fn();
const mockCanAdministerContent = vi.fn();
const mockFindWorkspaceInOrg = vi.fn();
const mockCreateInvite = vi.fn();
const mockFindLiveInvite = vi.fn();
const mockAccept = vi.fn();

// A db mock for exercising the REAL guest-store (via importActual) without a
// database: it captures the onConflictDoUpdate config so the membership-upsert
// guard can be asserted.
const dbMocks = vi.hoisted(() => {
  const state: { upsertConfig: Record<string, unknown> | undefined } = {
    upsertConfig: undefined,
  };
  const txMock = {
    update: () => ({ set: () => ({ where: async () => undefined }) }),
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: async (cfg: Record<string, unknown>) => {
          state.upsertConfig = cfg;
        },
      }),
    }),
    execute: async () => ({ rows: [{ organization_id: "team-1" }] }),
  };
  return {
    state,
    db: { transaction: (cb: (tx: typeof txMock) => unknown) => cb(txMock) },
  };
});

vi.mock("@sourceweft/db", () => ({
  db: dbMocks.db,
  workspaceGuestInvitations: {
    id: "id",
    email: "email",
    token: "token",
    status: "status",
    workspaceId: "workspace_id",
    expiresAt: "expires_at",
  },
  workspaceMemberships: {
    workspaceId: "workspace_id",
    userId: "user_id",
    source: "source",
    role: "role",
  },
}));

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
  dbMocks.state.upsertConfig = undefined;
  mockResolveAccess.mockResolvedValue({
    organizationId: "team-1",
    role: "workspace_admin",
    isContainerAdmin: false,
  });
  mockCanAdministerContent.mockReturnValue(true);
});

test("a workspace admin may invite a guest", async () => {
  mockFindWorkspaceInOrg.mockResolvedValue({ id: "ws-1", name: "Project X" });
  mockCreateInvite.mockResolvedValue({
    invitation: { email: "guest@x.com" },
    token: "tok",
  });

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

test("inviting a guest sets a bounded (~14 day) expiry on the invitation", async () => {
  mockFindWorkspaceInOrg.mockResolvedValue({ id: "ws-1", name: "Project X" });
  mockCreateInvite.mockResolvedValue({
    invitation: { email: "guest@x.com" },
    token: "tok",
  });

  const before = Date.now();
  await guestService.inviteGuest({
    workspaceId: "ws-1",
    actorUserId: "admin",
    email: "guest@x.com",
    role: "editor",
  });
  const after = Date.now();

  const passed = mockCreateInvite.mock.calls[0]?.[0] as { expiresAt: Date };
  assert.ok(passed.expiresAt instanceof Date, "expiresAt is a Date, not null");
  const ttlMs = 14 * 24 * 60 * 60 * 1000;
  assert.ok(passed.expiresAt.getTime() >= before + ttlMs);
  assert.ok(passed.expiresAt.getTime() <= after + ttlMs);
});

test("inviting still succeeds when the email fails to send", async () => {
  mockFindWorkspaceInOrg.mockResolvedValue({ id: "ws-1", name: "Project X" });
  mockCreateInvite.mockResolvedValue({
    invitation: { email: "guest@x.com" },
    token: "tok",
  });
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
    userEmail: "guest@x.com",
  });

  assert.deepEqual(result, { ok: false, reason: "invalid_invitation" });
});

test("accepting with an email that differs from the invited one is rejected", async () => {
  mockFindLiveInvite.mockResolvedValue({
    id: "inv-1",
    workspaceId: "ws-1",
    role: "editor",
    email: "invited@x.com",
  });

  const result = await guestService.acceptInvitation({
    token: "tok",
    userId: "impostor",
    userEmail: "someone-else@x.com",
  });

  assert.deepEqual(result, { ok: false, reason: "email_mismatch" });
  // The membership grant must never run on a mismatch.
  assert.equal(mockAccept.mock.calls.length, 0);
});

test("accepting with the invited email (case-insensitively) grants access", async () => {
  mockFindLiveInvite.mockResolvedValue({
    id: "inv-1",
    workspaceId: "ws-1",
    role: "editor",
    email: "guest@x.com",
  });
  mockAccept.mockResolvedValue({
    workspaceId: "ws-1",
    organizationId: "team-1",
  });

  const result = await guestService.acceptInvitation({
    token: "tok",
    userId: "guest-user",
    userEmail: "Guest@X.com",
  });

  assert.deepEqual(result, { ok: true, value: { workspaceId: "ws-1" } });
});

test("accepting a guest invite does not clobber a real member's row: the upsert is guarded by setWhere", async () => {
  // Exercise the REAL store (not the module mock) against the captured db mock.
  const store =
    await vi.importActual<typeof import("./guest-store")>("./guest-store");

  await store.acceptGuestInvitationRecord({
    invitation: {
      id: "inv-1",
      workspaceId: "ws-1",
      role: "editor",
      email: "member@x.com",
    } as never,
    userId: "member-user",
  });

  const cfg = dbMocks.state.upsertConfig;
  assert.ok(cfg, "the membership upsert (onConflictDoUpdate) ran");
  // The guard confines DO UPDATE to rows that are themselves guest grants, so a
  // pre-existing source='direct'/'derived' membership (e.g. a workspace_admin
  // override) is left untouched — it is never downgraded to editor/guest.
  assert.ok(cfg.setWhere, "the upsert carries a setWhere guard");
  const chunks = JSON.stringify(
    (cfg.setWhere as { queryChunks: unknown[] }).queryChunks,
  );
  assert.ok(chunks.includes("guest"), "setWhere restricts to source='guest'");
});
