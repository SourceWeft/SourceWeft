import { createHash, randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A local MCP server for the e2e that accepts OAuth OR an API key, the way
 * Arcmira does, so the whole member-chosen-method flow can run without a real
 * account: an unauthenticated call gets a 401 with an RFC 9728 challenge; the
 * OAuth side has protected-resource and authorization-server metadata, dynamic
 * client registration and an authorization-code + PKCE (S256) grant whose
 * "sign-in" is one Allow button; a `Bearer <API_KEY>` is accepted as well.
 * It also serves a one-entry registry (`/v0/servers`) for federation, and
 * `/_e2e/requests` lists which credential each MCP request carried.
 *
 * Run from `apps/backend`: `pnpm exec tsx scripts/mock-oauth-mcp-server-e2e.ts`.
 * Prints `{"origin": ...}` once listening. Never use outside a test.
 */
export const MOCK_REGISTRY_NAME = "io.github.sourceweft-e2e/mock-oauth-or-key";
export const MOCK_API_KEY = "mock_sk_live_e2e";

type Credential = "none" | "api_key" | "oauth" | "invalid";
const requests: Array<{ method: string; credential: Credential }> = [];
const clients = new Map<string, { redirectUris: string[] }>();
const codes = new Map<
  string,
  { clientId: string; redirectUri: string; challenge: string }
>();
const accessTokens = new Set<string>();
const refreshTokens = new Set<string>();

const server = createServer((request, reply) => {
  handle(request, reply).catch((error) => {
    reply.writeHead(500, { "content-type": "text/plain" });
    reply.end(error instanceof Error ? error.message : String(error));
  });
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const endpoint = `${origin}/mcp`;
const metadataUrl = `${origin}/.well-known/oauth-protected-resource/mcp`;
console.log(JSON.stringify({ origin }));

function json(
  reply: ServerResponse,
  status: number,
  body: unknown,
  headers = {},
) {
  reply.writeHead(status, { "content-type": "application/json", ...headers });
  reply.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function credentialOf(request: IncomingMessage): Credential {
  const header = request.headers.authorization ?? "";
  if (!header) return "none";
  const token = header.replace(/^Bearer\s+/i, "");
  if (token === MOCK_API_KEY) return "api_key";
  if (accessTokens.has(token)) return "oauth";
  return "invalid";
}

function issueTokens() {
  const access = `mock_at_${randomBytes(16).toString("hex")}`;
  const refresh = `mock_rt_${randomBytes(16).toString("hex")}`;
  accessTokens.add(access);
  refreshTokens.add(refresh);
  return {
    access_token: access,
    token_type: "Bearer",
    expires_in: 3600,
    refresh_token: refresh,
  };
}

async function handle(request: IncomingMessage, reply: ServerResponse) {
  const url = new URL(request.url ?? "/", origin);

  if (url.pathname === "/v0/servers") {
    return json(reply, 200, {
      servers: [
        {
          server: {
            name: MOCK_REGISTRY_NAME,
            title: "Mock OAuth-or-key MCP (e2e)",
            description: "Accepts OAuth or an API key, like Arcmira.",
            version: "1.0.0",
            remotes: [
              {
                type: "streamable-http",
                url: endpoint,
                headers: [
                  {
                    name: "Authorization",
                    isSecret: true,
                    description: `Bearer <key>. The e2e key is ${MOCK_API_KEY}. Omit the header and the host signs you in through OAuth.`,
                  },
                ],
              },
            ],
          },
          _meta: {
            "io.modelcontextprotocol.registry/official": { isLatest: true },
          },
        },
      ],
      metadata: { count: 1 },
    });
  }

  if (url.pathname === "/_e2e/requests") return json(reply, 200, requests);

  if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
    return json(reply, 200, {
      resource: endpoint,
      authorization_servers: [origin],
    });
  }
  if (url.pathname === "/.well-known/oauth-authorization-server") {
    return json(reply, 200, {
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      registration_endpoint: `${origin}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
  }

  if (url.pathname === "/register" && request.method === "POST") {
    const metadata = JSON.parse(await readBody(request)) as {
      redirect_uris?: string[];
    };
    const clientId = `mock_client_${randomBytes(8).toString("hex")}`;
    clients.set(clientId, { redirectUris: metadata.redirect_uris ?? [] });
    return json(reply, 201, {
      ...metadata,
      client_id: clientId,
      token_endpoint_auth_method: "none",
    });
  }

  if (url.pathname === "/authorize" && request.method === "GET") {
    const clientId = url.searchParams.get("client_id") ?? "";
    const redirectUri = url.searchParams.get("redirect_uri") ?? "";
    const challenge = url.searchParams.get("code_challenge") ?? "";
    if (
      !clients.get(clientId)?.redirectUris.includes(redirectUri) ||
      url.searchParams.get("code_challenge_method") !== "S256" ||
      !challenge
    ) {
      return json(reply, 400, { error: "invalid_request" });
    }
    const code = `mock_code_${randomBytes(16).toString("hex")}`;
    codes.set(code, { clientId, redirectUri, challenge });
    const back = new URL(redirectUri);
    back.searchParams.set("code", code);
    const state = url.searchParams.get("state");
    if (state) back.searchParams.set("state", state);
    reply.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return reply.end(
      `<!doctype html><title>Mock sign-in</title><h1>Mock sign-in</h1>` +
        `<p>Allow SourceWeft to use the mock MCP server?</p>` +
        `<a href="${back.href.replaceAll("&", "&amp;")}">Allow</a>`,
    );
  }

  if (url.pathname === "/token" && request.method === "POST") {
    const form = new URLSearchParams(await readBody(request));
    if (form.get("grant_type") === "refresh_token") {
      const refresh = form.get("refresh_token") ?? "";
      if (!refreshTokens.delete(refresh)) {
        return json(reply, 400, { error: "invalid_grant" });
      }
      return json(reply, 200, issueTokens());
    }
    const grant = codes.get(form.get("code") ?? "");
    const verifier = form.get("code_verifier") ?? "";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    if (
      !grant ||
      grant.clientId !== form.get("client_id") ||
      grant.redirectUri !== form.get("redirect_uri") ||
      grant.challenge !== challenge
    ) {
      return json(reply, 400, { error: "invalid_grant" });
    }
    codes.delete(form.get("code") ?? "");
    return json(reply, 200, issueTokens());
  }

  if (url.pathname === "/mcp") {
    if (request.method !== "POST") {
      reply.writeHead(405).end();
      return;
    }
    const message = JSON.parse(await readBody(request)) as {
      id?: number | string;
      method?: string;
      params?: { name?: string; arguments?: { text?: string } };
    };
    const credential = credentialOf(request);
    requests.push({ method: message.method ?? "", credential });
    if (credential === "none" || credential === "invalid") {
      return json(
        reply,
        401,
        {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32000,
            message:
              credential === "none"
                ? "No credential was sent."
                : "The key sent is not a live key.",
            data: {
              reason: credential === "none" ? "no_credential" : "invalid",
            },
          },
        },
        { "www-authenticate": `Bearer resource_metadata="${metadataUrl}"` },
      );
    }
    if (message.id === undefined) {
      reply.writeHead(202).end();
      return;
    }
    if (message.method === "initialize") {
      return json(reply, 200, {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "mock-oauth-or-key", version: "1.0.0" },
        },
      });
    }
    if (message.method === "tools/list") {
      return json(reply, 200, {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: [
            {
              name: "whoami",
              description: "Says which credential this call was made with.",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        },
      });
    }
    if (message.method === "tools/call") {
      return json(reply, 200, {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [{ type: "text", text: `called with ${credential}` }],
        },
      });
    }
    return json(reply, 200, {
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: "Method not found" },
    });
  }

  json(reply, 404, { error: "not_found" });
}
