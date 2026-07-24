import assert from "node:assert/strict";
import { test } from "vitest";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { McpOAuthClientProvider, type McpOAuthStore } from "./oauth-provider";

function fakeStore(): McpOAuthStore & { dump: () => Record<string, unknown> } {
  let clientInfo: OAuthClientInformationFull | undefined;
  let tokens: OAuthTokens | undefined;
  let verifier: string | undefined;
  let state: string | undefined;
  return {
    loadClientInformation: async () => clientInfo,
    saveClientInformation: async (info) => {
      clientInfo = info;
    },
    loadTokens: async () => tokens,
    saveTokens: async (t) => {
      tokens = t;
    },
    loadCodeVerifier: async () => verifier,
    saveCodeVerifier: async (v) => {
      verifier = v;
    },
    loadState: async () => state,
    saveState: async (s) => {
      state = s;
    },
    dump: () => ({ clientInfo, tokens, verifier, state }),
  };
}

const CONFIGURED = {
  "https://access.stripe.com": { clientId: "ca_stripe", clientSecret: "sk_secret" },
};

test("a configured confidential client is used for its matching issuer and never DCR'd", async () => {
  const store = fakeStore();
  const provider = new McpOAuthClientProvider({
    redirectUrl: "https://app.test/v1/mcp/oauth/callback",
    clientName: "SourceWeft",
    issuer: "https://access.stripe.com",
    configuredClients: CONFIGURED,
    store,
  });

  const info = await provider.clientInformation();
  assert.deepEqual(info, { client_id: "ca_stripe", client_secret: "sk_secret" });
  assert.equal(provider.clientMetadata.token_endpoint_auth_method, "client_secret_post");

  // The configured client must never be overwritten by a DCR save.
  await provider.saveClientInformation({
    client_id: "attacker",
    redirect_uris: ["https://app.test/v1/mcp/oauth/callback"],
  } as OAuthClientInformationFull);
  assert.equal(store.dump().clientInfo, undefined);
  assert.deepEqual(await provider.clientInformation(), {
    client_id: "ca_stripe",
    client_secret: "sk_secret",
  });
});

test("a configured secret is NOT offered to a different issuer (issuer binding)", async () => {
  const store = fakeStore();
  const provider = new McpOAuthClientProvider({
    redirectUrl: "https://app.test/v1/mcp/oauth/callback",
    clientName: "SourceWeft",
    // A malicious/other server declaring a different issuer must not receive
    // Stripe's secret.
    issuer: "https://evil.example.com",
    configuredClients: CONFIGURED,
    store,
  });

  assert.equal(await provider.clientInformation(), undefined);
  assert.equal(provider.clientMetadata.token_endpoint_auth_method, "none");
});

test("without a configured client, DCR registration is persisted and reused (public client)", async () => {
  const store = fakeStore();
  const provider = new McpOAuthClientProvider({
    redirectUrl: "https://app.test/v1/mcp/oauth/callback",
    clientName: "SourceWeft",
    issuer: "https://mcp.notion.com",
    configuredClients: CONFIGURED,
    store,
  });

  assert.equal(await provider.clientInformation(), undefined);
  assert.equal(provider.clientMetadata.token_endpoint_auth_method, "none");

  const registered = {
    client_id: "dcr_generated",
    redirect_uris: ["https://app.test/v1/mcp/oauth/callback"],
  } as OAuthClientInformationFull;
  await provider.saveClientInformation(registered);
  assert.deepEqual(await provider.clientInformation(), registered);
});

test("tokens round-trip through the store", async () => {
  const store = fakeStore();
  const provider = new McpOAuthClientProvider({
    redirectUrl: "https://app.test/cb",
    clientName: "SourceWeft",
    issuer: "https://mcp.notion.com",
    configuredClients: {},
    store,
  });
  assert.equal(await provider.tokens(), undefined);
  const tokens = { access_token: "at", token_type: "Bearer", refresh_token: "rt" } as OAuthTokens;
  await provider.saveTokens(tokens);
  assert.deepEqual(await provider.tokens(), tokens);
});

test("PKCE verifier throws until saved; state is generated once and reused", async () => {
  const store = fakeStore();
  const provider = new McpOAuthClientProvider({
    redirectUrl: "https://app.test/cb",
    clientName: "SourceWeft",
    issuer: "https://mcp.notion.com",
    configuredClients: {},
    store,
  });

  await assert.rejects(() => provider.codeVerifier(), /code verifier/i);
  await provider.saveCodeVerifier("verifier-123");
  assert.equal(await provider.codeVerifier(), "verifier-123");

  const first = await provider.state();
  const second = await provider.state();
  assert.equal(first, second);
  assert.ok(first.length > 0);
});

test("redirectToAuthorization hands the URL to the caller", async () => {
  const store = fakeStore();
  let captured: URL | null = null;
  const provider = new McpOAuthClientProvider({
    redirectUrl: "https://app.test/cb",
    clientName: "SourceWeft",
    issuer: "https://mcp.notion.com",
    configuredClients: {},
    store,
    onRedirect: (url) => {
      captured = url;
    },
  });
  await provider.redirectToAuthorization(new URL("https://mcp.notion.com/authorize?x=1"));
  assert.equal((captured as URL | null)?.toString(), "https://mcp.notion.com/authorize?x=1");
});
