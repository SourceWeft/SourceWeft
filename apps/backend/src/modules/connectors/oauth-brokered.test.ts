import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  workspace: vi.fn(),
  requireAvailable: vi.fn(),
  consume: vi.fn(),
  createState: vi.fn(),
  findAccount: vi.fn(),
  findState: vi.fn(),
  findReauthorizable: vi.fn(),
  reauthorize: vi.fn(),
  createAccount: vi.fn(),
  updateStatus: vi.fn(),
  updateToken: vi.fn(),
  startAuthorization: vi.fn(),
  finishAuthorization: vi.fn(),
  revokeAuthorization: vi.fn(),
  exchangeOAuthCode: vi.fn(),
  refreshOAuthToken: vi.fn(),
}));

vi.mock("../preview", () => ({
  previewAccessService: { isEnabled: vi.fn().mockResolvedValue(true) },
}));
vi.mock("./permissions", () => ({
  requireConnectorWorkspace: mocks.workspace,
}));
vi.mock("../../shared/config", () => ({
  config: { auth: { baseUrl: "https://api.sourceweft.test" } },
}));
vi.mock("../../shared/team-secrets", () => ({
  encryptTeamSecret: vi.fn(async (value: string) => `enc(${value})`),
  decryptTeamSecret: vi.fn(async (value: string) =>
    value.startsWith("enc(") ? value.slice(4, -1) : value,
  ),
}));
vi.mock("./repository", () => ({
  consumeOAuthStateRecord: mocks.consume,
  createOAuthAccountRecord: mocks.createAccount,
  createOAuthStateRecord: mocks.createState,
  findOAuthAccountRecord: mocks.findAccount,
  findOAuthStateRecord: mocks.findState,
  findReauthorizableOAuthAccountRecord: mocks.findReauthorizable,
  reauthorizeOAuthAccountRecord: mocks.reauthorize,
  updateOAuthAccountStatusRecord: mocks.updateStatus,
  updateOAuthAccountTokenRecord: mocks.updateToken,
}));

import { ConnectorError } from "./errors";
import { ConnectorOAuthService } from "./oauth-service";
import { ConnectorRegistry } from "./registry";

const brokeredManifest = {
  type: "composio_gmail",
  displayName: "Gmail (Composio)",
  auth: {
    kind: "brokered" as const,
    broker: "composio",
    scopes: ["gmail.readonly"],
  },
};

const notionManifest = {
  type: "notion",
  displayName: "Notion",
  auth: {
    kind: "oauth2" as const,
    authorizationUrl: "https://notion.example/oauth",
    tokenUrl: "https://notion.example/token",
    scopes: ["read"],
  },
};

const brokeredAdapter = {
  getManifest: () => brokeredManifest,
  exchangeOAuthCode: vi.fn(),
  refreshOAuthToken: vi.fn(),
  startAuthorization: mocks.startAuthorization,
  finishAuthorization: mocks.finishAuthorization,
  revokeAuthorization: mocks.revokeAuthorization,
};

const notionAdapter = {
  getManifest: () => notionManifest,
  exchangeOAuthCode: mocks.exchangeOAuthCode,
  refreshOAuthToken: mocks.refreshOAuthToken,
};

const registry = {
  getManifest: (connectorType: string) =>
    connectorType === "composio_gmail" ? brokeredManifest : notionManifest,
  getAdapter: (connectorType: string) =>
    connectorType === "composio_gmail" ? brokeredAdapter : notionAdapter,
};

const access = { requireAvailable: mocks.requireAvailable };
const service = new ConnectorOAuthService(registry as never, access as never);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.workspace.mockResolvedValue({
    workspace: { id: "workspace", organizationId: "team" },
  });
  mocks.requireAvailable.mockResolvedValue(undefined);
});

describe("start", () => {
  it("calls the brokered adapter with the callback URL and owner ref, then stores the returned attemptRef", async () => {
    mocks.startAuthorization.mockResolvedValue({
      authorizationUrl: "https://composio.example/authorize/abc",
      attemptRef: "attempt_1",
    });
    mocks.createState.mockResolvedValue({ id: "state-row" });

    const result = await service.start({
      workspaceId: "workspace",
      userId: "user",
      connectorType: "composio_gmail",
    });

    expect(mocks.workspace).toHaveBeenCalledWith({
      workspaceId: "workspace",
      userId: "user",
      permission: "connector.manage",
    });
    expect(mocks.requireAvailable).toHaveBeenCalledWith(
      "composio_gmail",
      "user",
    );
    expect(mocks.startAuthorization).toHaveBeenCalledTimes(1);

    const call = mocks.startAuthorization.mock.calls[0]?.[0];
    expect(call.ownerRef).toBe("ws_workspace");
    const calledUrl = new URL(call.callbackUrl);
    expect(calledUrl.origin + calledUrl.pathname).toBe(
      "https://api.sourceweft.test/v1/connectors/oauth/composio_gmail/callback",
    );
    const state = calledUrl.searchParams.get("state");
    expect(state).toBeTruthy();
    expect(call.callbackUrl.endsWith(`?state=${state}`)).toBe(true);

    expect(mocks.createState).toHaveBeenCalledTimes(1);
    const stateArgs = mocks.createState.mock.calls[0]?.[0];
    expect(stateArgs.attemptRef).toBe("attempt_1");
    expect(stateArgs.connectorType).toBe("composio_gmail");
    expect(stateArgs.teamId).toBe("team");
    expect(stateArgs.workspaceId).toBe("workspace");

    expect(result.authorizationUrl).toBe(
      "https://composio.example/authorize/abc",
    );
  });

  it("checks workspace permission before contacting the broker", async () => {
    mocks.workspace.mockRejectedValue(
      new ConnectorError(404, "WORKSPACE_NOT_FOUND", "not found"),
    );

    await expect(
      service.start({
        workspaceId: "workspace",
        userId: "user",
        connectorType: "composio_gmail",
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND" });
    expect(mocks.requireAvailable).not.toHaveBeenCalled();
    expect(mocks.startAuthorization).not.toHaveBeenCalled();
    expect(mocks.createState).not.toHaveBeenCalled();
  });

  it("checks the preview gate before contacting the broker", async () => {
    mocks.requireAvailable.mockRejectedValue(
      new ConnectorError(
        403,
        "CONNECTOR_PREVIEW_ACCESS_DENIED",
        "preview required",
      ),
    );

    await expect(
      service.start({
        workspaceId: "workspace",
        userId: "user",
        connectorType: "composio_gmail",
      }),
    ).rejects.toMatchObject({ code: "CONNECTOR_PREVIEW_ACCESS_DENIED" });
    expect(mocks.startAuthorization).not.toHaveBeenCalled();
    expect(mocks.createState).not.toHaveBeenCalled();
  });

  it("surfaces the adapter's own error code and status from startAuthorization unchanged", async () => {
    mocks.startAuthorization.mockRejectedValue(
      new ConnectorError(
        500,
        "CONNECTOR_OAUTH_CONFIG_MISSING",
        "Gmail (Composio) OAuth is not configured",
      ),
    );

    await expect(
      service.start({
        workspaceId: "workspace",
        userId: "user",
        connectorType: "composio_gmail",
      }),
    ).rejects.toMatchObject({
      statusCode: 500,
      code: "CONNECTOR_OAUTH_CONFIG_MISSING",
    });
    expect(mocks.createState).not.toHaveBeenCalled();
  });
});

describe("finishGlobalCallback (brokered)", () => {
  it("calls finishAuthorization with the stored attemptRef and the callback query, storing the credential encrypted with expiresAt null", async () => {
    mocks.consume.mockResolvedValue({
      workspaceId: "workspace",
      teamId: "team",
      userId: "user",
      connectorType: "composio_gmail",
      redirectAfter: "https://app.sourceweft.test/dashboard",
      attemptRef: "attempt_1",
    });
    mocks.finishAuthorization.mockResolvedValue({
      accessToken: "broker-credential",
      providerAccountId: "ca_1",
      providerAccountEmail: "person@example.com",
      displayName: "Person",
    });
    mocks.findReauthorizable.mockResolvedValue(null);
    mocks.createAccount.mockResolvedValue({ id: "account_1" });

    const callbackParams = {
      state: "state",
      status: "success",
      connected_account_id: "ca_1",
    };
    const result = await service.finishGlobalCallback({
      connectorType: "composio_gmail",
      state: "state",
      callbackParams,
    });

    expect(mocks.finishAuthorization).toHaveBeenCalledWith({
      callbackParams,
      attemptRef: "attempt_1",
      ownerRef: "ws_workspace",
    });
    expect(mocks.createAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        accessTokenEncrypted: "enc(broker-credential)",
        expiresAt: null,
        providerAccountId: "ca_1",
      }),
    );
    expect(result.account).toEqual({ id: "account_1" });
    expect(result.redirectAfter).toBe("https://app.sourceweft.test/dashboard");
  });

  it("fails a second callback that reuses the same (already-consumed) state", async () => {
    mocks.consume.mockResolvedValue(null);

    await expect(
      service.finishGlobalCallback({
        connectorType: "composio_gmail",
        state: "state",
        callbackParams: {},
      }),
    ).rejects.toMatchObject({ code: "CONNECTOR_OAUTH_STATE_INVALID" });
    expect(mocks.finishAuthorization).not.toHaveBeenCalled();
  });

  it("fails when the consumed state row carries no attemptRef", async () => {
    mocks.consume.mockResolvedValue({
      workspaceId: "workspace",
      teamId: "team",
      userId: "user",
      connectorType: "composio_gmail",
      redirectAfter: null,
      attemptRef: null,
    });

    await expect(
      service.finishGlobalCallback({
        connectorType: "composio_gmail",
        state: "state",
        callbackParams: {},
      }),
    ).rejects.toMatchObject({ code: "CONNECTOR_OAUTH_STATE_INVALID" });
    expect(mocks.finishAuthorization).not.toHaveBeenCalled();
  });

  it("surfaces the adapter's own error code and status from finishAuthorization unchanged", async () => {
    mocks.consume.mockResolvedValue({
      workspaceId: "workspace",
      teamId: "team",
      userId: "user",
      connectorType: "composio_gmail",
      redirectAfter: null,
      attemptRef: "attempt_1",
    });
    mocks.finishAuthorization.mockRejectedValue(
      new ConnectorError(
        500,
        "CONNECTOR_OAUTH_CONFIG_MISSING",
        "Gmail (Composio) OAuth is not configured",
      ),
    );

    await expect(
      service.finishGlobalCallback({
        connectorType: "composio_gmail",
        state: "state",
        callbackParams: {},
      }),
    ).rejects.toMatchObject({
      statusCode: 500,
      code: "CONNECTOR_OAUTH_CONFIG_MISSING",
    });
    expect(mocks.createAccount).not.toHaveBeenCalled();
  });
});

describe("an adapter without the brokered hooks (e.g. Notion)", () => {
  it("keeps running the standard OAuth2 code exchange", async () => {
    mocks.consume.mockResolvedValue({
      workspaceId: "workspace",
      teamId: "team",
      userId: "user",
      connectorType: "notion",
      redirectAfter: null,
      attemptRef: null,
    });
    mocks.exchangeOAuthCode.mockResolvedValue({
      accessToken: "token",
      providerAccountId: null,
    });
    mocks.createAccount.mockResolvedValue({ id: "account_2" });

    const result = await service.finishGlobalCallback({
      connectorType: "notion",
      state: "state",
      code: "code123",
    });

    expect(mocks.exchangeOAuthCode).toHaveBeenCalledTimes(1);
    expect(mocks.finishAuthorization).not.toHaveBeenCalled();
    expect(result.account).toEqual({ id: "account_2" });
  });

  it("still fails without a code, as today", async () => {
    mocks.consume.mockResolvedValue({
      workspaceId: "workspace",
      teamId: "team",
      userId: "user",
      connectorType: "notion",
      redirectAfter: null,
      attemptRef: null,
    });

    await expect(
      service.finishGlobalCallback({
        connectorType: "notion",
        state: "state",
      }),
    ).rejects.toMatchObject({ code: "CONNECTOR_OAUTH_CALLBACK_INVALID" });
    expect(mocks.exchangeOAuthCode).not.toHaveBeenCalled();
  });
});

describe("usesBrokeredAuthorization", () => {
  it("reflects the connector manifest's auth kind", () => {
    expect(service.usesBrokeredAuthorization("composio_gmail")).toBe(true);
    expect(service.usesBrokeredAuthorization("notion")).toBe(false);
  });
});

describe("getRuntimeToken", () => {
  it("returns the stored brokered credential unchanged and never refreshes it", async () => {
    mocks.findAccount.mockResolvedValue({
      id: "account_1",
      teamId: "team",
      workspaceId: "workspace",
      connectorType: "composio_gmail",
      status: "active",
      expiresAt: null,
      scopes: ["gmail.readonly"],
      accessTokenEncrypted: "enc(broker-credential)",
      refreshTokenEncrypted: null,
    });

    const token = await service.getRuntimeToken({
      teamId: "team",
      workspaceId: "workspace",
      accountId: "account_1",
      connectorType: "composio_gmail",
    });

    expect(token).toBe("broker-credential");
    expect(mocks.refreshOAuthToken).not.toHaveBeenCalled();
    expect(mocks.updateToken).not.toHaveBeenCalled();
  });
});

describe("revokeStoredAuthorization", () => {
  const brokeredAccount = {
    id: "account_1",
    teamId: "team",
    workspaceId: "workspace",
    connectorType: "composio_gmail",
    accessTokenEncrypted: "enc(broker-credential)",
    refreshTokenEncrypted: null,
  };

  it("is a no-op when the adapter has no revokeAuthorization hook", async () => {
    await service.revokeStoredAuthorization({
      ...brokeredAccount,
      connectorType: "notion",
    } as never);

    expect(mocks.revokeAuthorization).not.toHaveBeenCalled();
  });

  it("decrypts the stored credential and calls the adapter's revokeAuthorization", async () => {
    mocks.revokeAuthorization.mockResolvedValue(undefined);

    await service.revokeStoredAuthorization(brokeredAccount as never);

    expect(mocks.revokeAuthorization).toHaveBeenCalledWith({
      accessToken: "broker-credential",
    });
  });

  it("wraps an adapter revoke failure as CONNECTOR_AUTHORIZATION_REVOKE_FAILED", async () => {
    mocks.revokeAuthorization.mockRejectedValue(new Error("provider is down"));

    await expect(
      service.revokeStoredAuthorization(brokeredAccount as never),
    ).rejects.toMatchObject({
      statusCode: 502,
      code: "CONNECTOR_AUTHORIZATION_REVOKE_FAILED",
    });
  });

  it("resolves (so the local delete still proceeds) when the connector's adapter is switched off at deployment level", async () => {
    const switchedOffService = new ConnectorOAuthService(
      new ConnectorRegistry(),
      access as never,
    );

    await expect(
      switchedOffService.revokeStoredAuthorization(brokeredAccount as never),
    ).resolves.toBeUndefined();
    expect(mocks.revokeAuthorization).not.toHaveBeenCalled();
  });
});
