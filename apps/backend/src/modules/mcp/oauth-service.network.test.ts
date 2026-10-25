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
  deletedCredentials: [] as Array<Record<string, string>>,
  registerDelayMs: 0,
  pending: undefined as
    | {
        state: string;
        codeVerifier: string;
        issuer: string;
        returnTo: string | null;
      }
    | undefined,
  lastVerifier: undefined as string | undefined,
  membership: true,
  beginAccepts: true,
  stored: {
    client: undefined as OAuthClientInformationFull | undefined,
    tokens: undefined as OAuthTokens | undefined,
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
vi.mock("./network", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./network")>()),
  // Short deadlines, so the timeout paths run in milliseconds.
  MCP_OAUTH_START_DEADLINE_MS: 3_000,
  MCP_OAUTH_EXCHANGE_DEADLINE_MS: 3_000,
}));
vi.mock("./permissions", () => ({
  requireMcpWorkspace: async () => {
    if (!state.membership) throw new Error("not a member");
    return { workspace: { id: "workspace", organizationId: "team" } };
  },
}));
vi.mock("./repository", () => ({
  findWorkspaceMcpInstall: async () => ({
    id: "install",
    authType: "oauth",
    endpointUrl: state.endpoint,
  }),
  deleteWorkspaceMcpCredential: async (scope: Record<string, string>) => {
    state.deletedCredentials.push(scope);
  },
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
    // PKCE verifier and state live in the pending attempt, not in the store.
    loadCodeVerifier: async () => undefined,
    saveCodeVerifier: async () => {
      throw new Error("the verifier must be recorded with the attempt");
    },
    loadState: async () => undefined,
    saveState: async () => {
      throw new Error("the state must be recorded with the attempt");
    },
  }),
  beginMcpOAuthAttempt: async (
    _scope: unknown,
    attempt: NonNullable<typeof state.pending>,
  ) => {
    if (!state.beginAccepts) return false;
    state.pending = attempt;
    state.lastVerifier = attempt.codeVerifier;
    return true;
  },
  consumeMcpOAuthAttempt: async (nonce: string) => {
    const pending = state.pending;
    if (!pending || pending.state !== nonce) return null;
    state.pending = undefined;
    return {
      scope: {
        teamId: "team",
        workspaceId: "workspace",
        installId: "install",
        userId: "user",
      },
      issuer: pending.issuer,
      codeVerifier: pending.codeVerifier,
      returnTo: pending.returnTo,
    };
  },
  recordMcpOAuthCompletion: async () => "ref-1",
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
  state.deletedCredentials = [];
  state.addressChecks = true;
  state.origins = [];
  state.denyToken = false;
  state.redirectMetadata = false;
  state.stored = { client: undefined, tokens: undefined };
  state.pending = undefined;
  state.lastVerifier = undefined;
  state.registerDelayMs = 0;
  state.membership = true;
  state.beginAccepts = true;
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
      if (state.registerDelayMs) {
        setTimeout(() => res.end("{}"), state.registerDelayMs);
        return;
      }
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
        if (fields.get("code_verifier") !== state.lastVerifier) {
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
      returnTo: "/dashboard/mcp/io.github.o%2Fexample",
    });
    assert.equal(result.status, "redirect");
    if (result.status !== "redirect") throw new Error("expected redirect");
    const redirect = new URL(result.authorizationUrl);
    assert.equal(redirect.origin, state.issuer);
    assert.equal(redirect.searchParams.get("code_challenge_method"), "S256");
    assert.equal(redirect.searchParams.get("state"), state.pending?.state);
    assert.ok(redirect.searchParams.get("code_challenge"));
    assert.equal(state.pending?.returnTo, "/dashboard/mcp/io.github.o%2Fexample");
    assert.equal(state.pending?.issuer, state.issuer);
    const nonce = state.pending!.state;
    assert.deepEqual(state.deletedCredentials, []);
    assert.deepEqual(
      await completeMcpOAuthCallback({ state: nonce, code: "fixture-code" }),
      {
        outcome: "connected",
        returnTo: "/dashboard/mcp/io.github.o%2Fexample",
        completionRef: "ref-1",
      },
    );
    assert.equal(state.stored.tokens?.access_token, "fixture-access");
    // Connecting OAuth replaces only this member's static credential.
    assert.deepEqual(state.deletedCredentials, [
      {
        teamId: "team",
        workspaceId: "workspace",
        installId: "install",
        userId: "user",
      },
    ]);
    // The attempt is single use: a replay finds nothing.
    assert.deepEqual(
      await completeMcpOAuthCallback({ state: nonce, code: "fixture-code" }),
      { outcome: "invalid" },
    );
  },
);

test("each attempt gets a fresh state and a later one supersedes the earlier", async () => {
  await fixture();
  const input = { workspaceId: "workspace", installId: "install", userId: "user" };
  await startMcpOAuthAuthorization(input);
  const first = state.pending!.state;
  await startMcpOAuthAuthorization(input);
  const second = state.pending!.state;
  assert.notEqual(first, second);
  assert.deepEqual(
    await completeMcpOAuthCallback({ state: first, code: "fixture-code" }),
    { outcome: "invalid" },
  );
  assert.equal(
    (await completeMcpOAuthCallback({ state: second, code: "fixture-code" }))
      .outcome,
    "connected",
  );
});

test("a start that a newer one has already replaced reports it and records nothing", async () => {
  await fixture();
  state.beginAccepts = false;
  await assert.rejects(
    startMcpOAuthAuthorization({
      workspaceId: "workspace",
      installId: "install",
      userId: "user",
    }),
    (error: unknown) =>
      (error as { code?: string }).code === "MCP_OAUTH_SUPERSEDED",
  );
  assert.equal(state.pending, undefined);
});

test("a callback by another signed-in member is refused after the attempt is spent", async () => {
  await fixture();
  await startMcpOAuthAuthorization({
    workspaceId: "workspace",
    installId: "install",
    userId: "user",
  });
  const nonce = state.pending!.state;
  assert.deepEqual(
    await completeMcpOAuthCallback({
      state: nonce,
      code: "fixture-code",
      sessionUserId: "someone-else",
    }),
    { outcome: "invalid" },
  );
  assert.equal(state.stored.tokens, undefined);
  assert.equal(state.pending, undefined);
});

test("a disallowed return destination is refused before anything is contacted", async () => {
  await fixture();
  await assert.rejects(
    startMcpOAuthAuthorization({
      workspaceId: "workspace",
      installId: "install",
      userId: "user",
      returnTo: "https://evil.example/dashboard/mcp",
    }),
    /return destination/,
  );
  assert.deepEqual(state.calls, []);
  assert.equal(state.pending, undefined);
});

test("a denial or provider error is handled through the bound attempt", async () => {
  await fixture();
  await startMcpOAuthAuthorization({
    workspaceId: "workspace",
    installId: "install",
    userId: "user",
    returnTo: "/dashboard/mcp",
  });
  const nonce = state.pending!.state;
  assert.deepEqual(
    await completeMcpOAuthCallback({ state: nonce, providerError: "access_denied" }),
    { outcome: "denied", returnTo: "/dashboard/mcp", reason: "denied" },
  );
  assert.equal(state.stored.tokens, undefined);
  assert.equal(state.pending, undefined);
  // The same value cannot be replayed with a code afterwards.
  assert.deepEqual(
    await completeMcpOAuthCallback({ state: nonce, code: "fixture-code" }),
    { outcome: "invalid" },
  );
});

test("membership lost since the attempt started ends the callback without a token exchange", async () => {
  await fixture();
  await startMcpOAuthAuthorization({
    workspaceId: "workspace",
    installId: "install",
    userId: "user",
  });
  state.membership = false;
  const callsBefore = state.calls.length;
  const result = await completeMcpOAuthCallback({
    state: state.pending!.state,
    code: "fixture-code",
  });
  assert.equal(result.outcome, "failed");
  assert.equal(state.calls.length, callsBefore);
  assert.equal(state.stored.tokens, undefined);
  assert.deepEqual(state.deletedCredentials, []);
});

test("a stalled registration ends in MCP_OAUTH_TIMEOUT at the deadline", async () => {
  await fixture();
  state.registerDelayMs = 20_000;
  const startedAt = Date.now();
  await assert.rejects(
    startMcpOAuthAuthorization({
      workspaceId: "workspace",
      installId: "install",
      userId: "user",
    }),
    (error: unknown) =>
      (error as { code?: string }).code === "MCP_OAUTH_TIMEOUT",
  );
  assert.ok(Date.now() - startedAt < 10_000);
  assert.equal(state.pending, undefined);
});

test("untrusted token metadata cannot make the host contact a metadata address", async () => {
  await fixture();
  await startMcpOAuthAuthorization({
    workspaceId: "workspace",
    installId: "install",
    userId: "user",
  });
  state.denyToken = true;
  const result = await completeMcpOAuthCallback({
    state: state.pending!.state,
    code: "fixture-code",
  });
  assert.equal(result.outcome, "failed");
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
