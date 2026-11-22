import type { ConnectorAdapter } from "@sourceweft/contracts/connectors";
import { describe, expect, it } from "vitest";
import { requireOAuthMethods } from "./oauth-methods";

const exchangeOAuthCode = async () => ({ accessToken: "a" });
const refreshOAuthToken = async () => ({ accessToken: "b" });

function adapter(partial: Partial<ConnectorAdapter>): ConnectorAdapter {
  return partial as ConnectorAdapter;
}

describe("requireOAuthMethods", () => {
  it("returns both methods of a complete adapter", async () => {
    const methods = requireOAuthMethods(
      adapter({ exchangeOAuthCode, refreshOAuthToken }),
      "gmail",
    );
    await expect(
      methods.exchangeOAuthCode({ code: "c", redirectUri: "https://x/cb", scopes: [] }),
    ).resolves.toEqual({ accessToken: "a" });
    await expect(
      methods.refreshOAuthToken({ refreshToken: "r", scopes: [] }),
    ).resolves.toEqual({ accessToken: "b" });
  });

  it("keeps the adapter as `this` for class-based adapters", async () => {
    class Impl {
      readonly tag = "impl";
      async exchangeOAuthCode() {
        return { accessToken: this.tag };
      }
      async refreshOAuthToken() {
        return { accessToken: this.tag };
      }
    }
    const methods = requireOAuthMethods(
      new Impl() as unknown as ConnectorAdapter,
      "gmail",
    );
    await expect(
      methods.exchangeOAuthCode({ code: "c", redirectUri: "https://x/cb", scopes: [] }),
    ).resolves.toEqual({ accessToken: "impl" });
  });

  it("throws CONNECTOR_AUTH_KIND_UNSUPPORTED when refreshOAuthToken is missing", () => {
    expect(() =>
      requireOAuthMethods(adapter({ exchangeOAuthCode }), "rss"),
    ).toThrowError(
      expect.objectContaining({
        statusCode: 500,
        code: "CONNECTOR_AUTH_KIND_UNSUPPORTED",
      }),
    );
  });

  it("throws CONNECTOR_AUTH_KIND_UNSUPPORTED when exchangeOAuthCode is missing", () => {
    expect(() =>
      requireOAuthMethods(adapter({ refreshOAuthToken }), "rss"),
    ).toThrowError(
      expect.objectContaining({ code: "CONNECTOR_AUTH_KIND_UNSUPPORTED" }),
    );
  });
});
