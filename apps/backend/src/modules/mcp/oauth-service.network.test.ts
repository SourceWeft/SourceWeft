import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, test, vi } from "vitest";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

const state = vi.hoisted(() => ({
  addressChecks: true,
  endpoint: "",
  issuer: "",
  denyToken: false,
  redirectMetadata: false,
  origins: [] as string[],
  calls: [] as string[],
  stored: {
    client: undefined as OAuthClientInformationFull | undefined,
    tokens: undefined as OAuthTokens | undefined,
    verifier: undefined as string | undefined,
    nonce: undefined as string | undefined,
  },
}));
vi.mock("../../shared/config", () => ({
  config: {
    get endpointAddressChecksEnabled() {
      return state.addressChecks;
    },
    get mcpAllowedInternalOrigins() {
      return state.origins;
    },
    mcpOAuth: {
      redirectUrl: "http://localhost/callback",
      clientName: "test",
      clients: {},
    },
  },
}));
vi.mock("./permissions", () => ({
  requireMcpWorkspace: async () => ({
    workspace: { id: "workspace", organizationId: "team" },
  }),
}));
vi.mock("./repository", () => ({
  findWorkspaceMcpInstall: async () => ({
    id: "install",
    authType: "oauth",
    endpointUrl: state.endpoint,
  }),
}));
vi.mock("./oauth-repository", () => ({
  getMcpOAuthStatus: async () => ({ connected: false }),
  createDbMcpOAuthStore: () => ({
    loadClientInformation: async () => state.stored.client,
    saveClientInformation: async (value: OAuthClientInformationFull) => {
      state.stored.client = value;
    },
    loadTokens: async () => state.stored.tokens,
    saveTokens: async (value: OAuthTokens) => {
      state.stored.tokens = value;
    },
    loadCodeVerifier: async () => state.stored.verifier,
    saveCodeVerifier: async (value: string) => {
      state.stored.verifier = value;
    },
    loadState: async () => state.stored.nonce,
    saveState: async (value: string) => {
      state.stored.nonce = value;
    },
  }),
  findMcpOAuthSessionByState: async (nonce: string) =>
    nonce === state.stored.nonce
      ? {
          scope: {
            teamId: "team",
            workspaceId: "workspace",
            installId: "install",
            userId: "user",
          },
          issuer: state.issuer,
        }
      : null,
  clearMcpOAuthTransient: async () => {
    state.stored.nonce = undefined;
    state.stored.verifier = undefined;
  },
}));

import {
  startMcpOAuthAuthorization,
  completeMcpOAuthCallback,
} from "./oauth-service";
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  state.calls = [];
  state.addressChecks = true;
  state.origins = [];
  state.denyToken = false;
  state.redirectMetadata = false;
  state.stored = {
    client: undefined,
    tokens: undefined,
    verifier: undefined,
    nonce: undefined,
  };
});

async function fixture() {
  const server = createServer((req, res) => {
    state.calls.push(req.url ?? "");
    res.setHeader("Content-Type", "application/json");
    if (req.url?.startsWith("/.well-known/oauth-protected-resource")) {
      if (state.redirectMetadata) {
        res.writeHead(302, { location: "http://169.254.169.254/metadata" });
        res.end();
        return;
      }
      res.end(
        JSON.stringify({
          resource: state.endpoint,
          authorization_servers: [state.issuer],
        }),
      );
      return;
    }
    if (req.url === "/.well-known/oauth-authorization-server") {
      res.end(
        JSON.stringify({
          issuer: state.issuer,
          authorization_endpoint: `${state.issuer}/authorize`,
          token_endpoint: state.denyToken
            ? "http://169.254.169.254/token"
            : `${state.issuer}/token`,
          registration_endpoint: `${state.issuer}/register`,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        }),
      );
      return;
    }
    if (req.url === "/register") {
      res.end(
        JSON.stringify({
          client_id: "fixture-client",
          redirect_uris: ["http://localhost/callback"],
        }),
      );
      return;
    }
    if (req.url === "/token") {
      let body = "";
      req.on("data", (part) => {
        body += part;
      });
      req.on("end", () => {
        const fields = new URLSearchParams(body);
        if (fields.get("code_verifier") !== state.stored.verifier) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
        res.end(
          JSON.stringify({
            access_token: "fixture-access",
            refresh_token: "fixture-refresh",
            token_type: "Bearer",
            expires_in: 3600,
          }),
        );
      });
      return;
    }
    res.writeHead(404);
    res.end("{}");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.endpoint = `${state.issuer}/mcp`;
  state.origins = [state.issuer];
}

test.each([true, false])(
  "host OAuth uses SDK DCR, PKCE, state and token exchange with address checks=%s",
  async (addressChecks) => {
    await fixture();
    state.addressChecks = addressChecks;
    if (!addressChecks) state.origins = [];
    const result = await startMcpOAuthAuthorization({
      workspaceId: "workspace",
      installId: "install",
      userId: "user",
    });
    assert.equal(result.status, "redirect");
    if (result.status !== "redirect") throw new Error("expected redirect");
    const redirect = new URL(result.authorizationUrl);
    assert.equal(redirect.origin, state.issuer);
    assert.equal(redirect.searchParams.get("code_challenge_method"), "S256");
    assert.equal(redirect.searchParams.get("state"), state.stored.nonce);
    assert.ok(redirect.searchParams.get("code_challenge"));
    const nonce = state.stored.nonce!;
    assert.deepEqual(
      await completeMcpOAuthCallback({ state: nonce, code: "fixture-code" }),
      { workspaceId: "workspace", installId: "install" },
    );
    assert.equal(state.stored.tokens?.access_token, "fixture-access");
    assert.equal(state.stored.nonce, undefined);
    await assert.rejects(
      completeMcpOAuthCallback({ state: nonce, code: "fixture-code" }),
    );
  },
);

test("untrusted token metadata cannot make the host contact a metadata address", async () => {
  await fixture();
  await startMcpOAuthAuthorization({
    workspaceId: "workspace",
    installId: "install",
    userId: "user",
  });
  state.denyToken = true;
  await assert.rejects(
    completeMcpOAuthCallback({
      state: state.stored.nonce!,
      code: "fixture-code",
    }),
    /allowed|HTTPS/,
  );
  assert.equal(state.stored.tokens, undefined);
  assert.ok(!state.calls.includes("/token"));
});

test("SDK metadata compatibility cannot swallow a policy denial and issue more requests", async () => {
  await fixture();
  state.redirectMetadata = true;
  await assert.rejects(
    startMcpOAuthAuthorization({
      workspaceId: "workspace",
      installId: "install",
      userId: "user",
    }),
    /allowed|HTTPS/,
  );
  assert.equal(state.calls.length, 1);
  assert.equal(state.stored.client, undefined);
});
