import { describe, expect, it, vi } from "vitest";
import { ConnectorError } from "./errors";
import { resolveCredential } from "./credential";
import type { ConnectorManifest } from "./types";

function manifestOf(auth: unknown): ConnectorManifest {
  return { type: "t", auth } as unknown as ConnectorManifest;
}

function deps(auth: unknown, getRuntimeToken = vi.fn().mockResolvedValue("tok")) {
  return {
    getRuntimeToken: getRuntimeToken as never,
    getManifest: vi.fn().mockReturnValue(manifestOf(auth)),
    getRuntimeTokenMock: getRuntimeToken,
  };
}

const scope = { teamId: "team_1", workspaceId: "workspace_1" };

describe("resolveCredential", () => {
  it("returns an empty token for a none connector without reading the account", async () => {
    const throwing = vi.fn().mockRejectedValue(new Error("must not be called"));
    const d = deps({ kind: "none" }, throwing);

    await expect(
      resolveCredential(d, {
        ...scope,
        connector: { connectorType: "public-feed", oauthAccountId: null },
      }),
    ).resolves.toBe("");
    expect(throwing).not.toHaveBeenCalled();
    expect(d.getManifest).toHaveBeenCalledWith("public-feed");
  });

  it.each([
    {
      kind: "oauth2",
      authorizationUrl: "https://example.com/auth",
      tokenUrl: "https://example.com/token",
      scopes: [],
    },
    { kind: "brokered" },
  ])("resolves the runtime token for $kind", async (auth) => {
    const d = deps(auth);

    await expect(
      resolveCredential(d, {
        ...scope,
        connector: { connectorType: "gmail", oauthAccountId: "account_1" },
      }),
    ).resolves.toBe("tok");
    expect(d.getRuntimeTokenMock).toHaveBeenCalledWith({
      teamId: "team_1",
      workspaceId: "workspace_1",
      accountId: "account_1",
      connectorType: "gmail",
    });
  });

  it("treats a manifest without auth as oauth2", async () => {
    const d = deps(undefined);

    await expect(
      resolveCredential(d, {
        ...scope,
        connector: { connectorType: "legacy", oauthAccountId: "account_1" },
      }),
    ).resolves.toBe("tok");
    expect(d.getRuntimeTokenMock).toHaveBeenCalledTimes(1);
  });

  it("keeps CONNECTOR_OAUTH_ACCOUNT_REQUIRED for an oauth2 connector without an account", async () => {
    const real = vi.fn().mockImplementation(async (input: { accountId: string | null }) => {
      if (!input.accountId) {
        throw new ConnectorError(
          400,
          "CONNECTOR_OAUTH_ACCOUNT_REQUIRED",
          "Connector OAuth account is required",
        );
      }
      return "tok";
    });
    const d = deps({ kind: "oauth2" }, real);

    await expect(
      resolveCredential(d, {
        ...scope,
        connector: { connectorType: "gmail", oauthAccountId: null },
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "CONNECTOR_OAUTH_ACCOUNT_REQUIRED",
    });
  });
});
