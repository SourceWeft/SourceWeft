import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  workspace: vi.fn(),
  consume: vi.fn(),
  exchange: vi.fn(),
  createAccount: vi.fn(),
  findReauthorizable: vi.fn(),
  reauthorize: vi.fn(),
}));
vi.mock("../preview", () => ({
  previewAccessService: { isEnabled: vi.fn().mockResolvedValue(true) },
}));
vi.mock("./permissions", () => ({
  requireConnectorWorkspace: mocks.workspace,
}));
vi.mock("../../shared/team-secrets", () => ({
  encryptTeamSecret: vi.fn(async (value: string) => `enc(${value})`),
  decryptTeamSecret: vi.fn(),
}));
vi.mock("./repository", () => ({
  consumeOAuthStateRecord: mocks.consume,
  createOAuthAccountRecord: mocks.createAccount,
  createOAuthStateRecord: vi.fn(),
  findOAuthAccountRecord: vi.fn(),
  findOAuthStateRecord: vi.fn(),
  findReauthorizableOAuthAccountRecord: mocks.findReauthorizable,
  reauthorizeOAuthAccountRecord: mocks.reauthorize,
  updateOAuthAccountStatusRecord: vi.fn(),
  updateOAuthAccountTokenRecord: vi.fn(),
}));

import { ConnectorOAuthService } from "./oauth-service";

const manifest = {
  type: "google_drive",
  displayName: "Google Drive",
  auth: { scopes: ["drive.file"] },
};
const registry = {
  getManifest: () => manifest,
  getAdapter: () => ({
    getManifest: () => manifest,
    exchangeOAuthCode: mocks.exchange,
  }),
};
const access = { requireAvailable: vi.fn() };
const service = new ConnectorOAuthService(registry as never, access as never);
const expiresAt = new Date("2026-11-14T10:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.workspace.mockResolvedValue({
    workspace: { id: "workspace", organizationId: "team" },
  });
  mocks.consume.mockResolvedValue({
    workspaceId: "workspace",
    teamId: "team",
    userId: "user",
    redirectAfter: "http://localhost:3000/dashboard",
  });
  mocks.exchange.mockResolvedValue({
    accessToken: "access-2",
    refreshToken: "refresh-2",
    expiresAt,
    providerAccountId: "permission-1",
    providerAccountEmail: "person@example.com",
    displayName: "Person",
  });
  mocks.createAccount.mockResolvedValue({ id: "new-account" });
  mocks.reauthorize.mockResolvedValue({ id: "existing-account" });
});

const call = (method: "finish" | "finishGlobalCallback") =>
  service[method]({
    connectorType: "google_drive",
    workspaceId: "workspace",
    state: "state",
    code: "code",
  });

it.each(["finish", "finishGlobalCallback"] as const)(
  "%s refreshes the stored authorization when the same provider account authorizes again",
  async (method) => {
    mocks.findReauthorizable.mockResolvedValue({ id: "existing-account" });

    const result = await call(method);

    expect(mocks.findReauthorizable).toHaveBeenCalledWith({
      teamId: "team",
      workspaceId: "workspace",
      connectorType: "google_drive",
      providerAccountId: "permission-1",
    });
    expect(mocks.reauthorize).toHaveBeenCalledWith({
      teamId: "team",
      workspaceId: "workspace",
      accountId: "existing-account",
      providerAccountEmail: "person@example.com",
      displayName: "Person",
      scopes: ["drive.file"],
      accessTokenEncrypted: "enc(access-2)",
      refreshTokenEncrypted: "enc(refresh-2)",
      expiresAt,
    });
    expect(mocks.createAccount).not.toHaveBeenCalled();
    expect(result.account).toEqual({ id: "existing-account" });
    expect(result.redirectAfter).toBe("http://localhost:3000/dashboard");
  },
);

it("keeps the stored refresh token when the provider does not issue a new one", async () => {
  mocks.findReauthorizable.mockResolvedValue({ id: "existing-account" });
  mocks.exchange.mockResolvedValue({
    accessToken: "access-2",
    providerAccountId: "permission-1",
  });

  await call("finishGlobalCallback");

  expect(mocks.reauthorize).toHaveBeenCalledWith(
    expect.objectContaining({ refreshTokenEncrypted: undefined }),
  );
});

it.each(["finish", "finishGlobalCallback"] as const)(
  "%s stores a new authorization for a provider account not seen in this workspace",
  async (method) => {
    mocks.findReauthorizable.mockResolvedValue(null);

    const result = await call(method);

    expect(mocks.reauthorize).not.toHaveBeenCalled();
    expect(mocks.createAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: "team",
        workspaceId: "workspace",
        connectorType: "google_drive",
        providerAccountId: "permission-1",
        accessTokenEncrypted: "enc(access-2)",
        refreshTokenEncrypted: "enc(refresh-2)",
        createdBy: "user",
      }),
    );
    expect(result.account).toEqual({ id: "new-account" });
  },
);

it("stores a new authorization when the provider does not identify the account", async () => {
  mocks.exchange.mockResolvedValue({ accessToken: "access-2" });

  await call("finishGlobalCallback");

  expect(mocks.findReauthorizable).not.toHaveBeenCalled();
  expect(mocks.createAccount).toHaveBeenCalledWith(
    expect.objectContaining({
      providerAccountId: null,
      displayName: "Google Drive account",
    }),
  );
});

it("stores a new authorization when the stored one disappears before it can be refreshed", async () => {
  mocks.findReauthorizable.mockResolvedValue({ id: "existing-account" });
  mocks.reauthorize.mockResolvedValue(null);

  const result = await call("finishGlobalCallback");

  expect(mocks.createAccount).toHaveBeenCalledTimes(1);
  expect(result.account).toEqual({ id: "new-account" });
});
