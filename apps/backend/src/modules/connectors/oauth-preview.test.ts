import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  enabled: vi.fn(),
  workspace: vi.fn(),
  consume: vi.fn(),
  account: vi.fn(),
  exchange: vi.fn(),
  createAccount: vi.fn(),
}));
vi.mock("../preview", () => ({
  previewAccessService: { isEnabled: mocks.enabled },
}));
vi.mock("./permissions", () => ({
  requireConnectorWorkspace: mocks.workspace,
}));
vi.mock("./repository", () => ({
  consumeOAuthStateRecord: mocks.consume,
  createOAuthAccountRecord: mocks.createAccount,
  createOAuthStateRecord: vi.fn(),
  findOAuthAccountRecord: mocks.account,
  findOAuthStateRecord: vi.fn(),
  updateOAuthAccountStatusRecord: vi.fn(),
  updateOAuthAccountTokenRecord: vi.fn(),
}));
import { ConnectorOAuthService } from "./oauth-service";
const registry = {
  getManifest: () => ({ type: "gmail" }),
  getAdapter: () => ({
    getManifest: () => ({ type: "gmail" }),
    exchangeOAuthCode: mocks.exchange,
  }),
};
const service = new ConnectorOAuthService(registry as never);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.workspace.mockResolvedValue({
    workspace: { id: "workspace", organizationId: "team" },
  });
  mocks.consume.mockResolvedValue({
    workspaceId: "workspace",
    teamId: "team",
    userId: "user",
  });
  mocks.enabled.mockResolvedValue(false);
});
it.each(["finish", "finishGlobalCallback"] as const)(
  "%s rechecks revoked preview before exchanging authorization code",
  async (method) => {
    await expect(
      service[method]({
        connectorType: "gmail",
        workspaceId: "workspace",
        state: "state",
        code: "code",
      }),
    ).rejects.toMatchObject({ code: "CONNECTOR_PREVIEW_ACCESS_DENIED" });
    expect(mocks.workspace).toHaveBeenCalledWith({
      workspaceId: "workspace",
      userId: "user",
      permission: "connector.manage",
    });
    expect(mocks.exchange).not.toHaveBeenCalled();
    expect(mocks.createAccount).not.toHaveBeenCalled();
  },
);
it("callback rechecks workspace permissions even when preview remains granted", async () => {
  mocks.enabled.mockResolvedValue(true);
  mocks.workspace.mockRejectedValue(new Error("membership revoked"));
  await expect(
    service.finish({
      connectorType: "gmail",
      workspaceId: "workspace",
      state: "state",
      code: "code",
    }),
  ).rejects.toThrow("membership revoked");
  expect(mocks.exchange).not.toHaveBeenCalled();
});
