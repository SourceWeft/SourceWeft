import { createHash, randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

/**
 * One loopback HTTP server that is both an MCP endpoint (`/mcp`) and its
 * OAuth authorization server: protected-resource and authorization-server
 * metadata, dynamic client registration, `/authorize`, and `/token` with
 * PKCE checks and refresh. Tokens it issues are the only ones `/mcp` takes.
 */

export type FakeOAuthMcpOptions = {
  /** Offer `/register`; false reproduces vendors without dynamic registration. */
  registration?: boolean;
  /** `expires_in` of issued access tokens, seconds. */
  expiresIn?: number;
  /** What `/authorize` answers: approve, deny, or approve with another state. */
  consent?: "approve" | "deny" | "wrong-state";
  /** `/token` answers this error body (HTTP 400) instead of issuing tokens. */
  tokenError?: (code: string) => string;
  /** `/mcp` answers a 307 to this URL once authenticated. */
  redirectMcpTo?: string;
  tools?: unknown[];
};

type Client = { clientId: string; redirectUris: string[] };
type Grant = {
  clientId: string;
  redirectUri: string;
  challenge: string;
  resource?: string;
};

export type FakeOAuthMcp = {
  server: Server;
  origin: string;
  /** The MCP endpoint, `${origin}/mcp`. */
  url: string;
  requests: { method: string; path: string; authorization?: string }[];
  registrations: Record<string, unknown>[];
  authorizeQueries: URLSearchParams[];
  tokenRequests: URLSearchParams[];
  /** Access tokens `/mcp` accepts. */
  validTokens: Set<string>;
  validRefreshTokens: Set<string>;
  options: FakeOAuthMcpOptions;
  close: () => Promise<void>;
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

export const DEFAULT_TOOLS = [
  {
    name: "search_docs",
    description: "Search the documentation",
    inputSchema: { type: "object", properties: { q: { type: "string" } } },
    annotations: { readOnlyHint: true },
  },
  { name: "create_page", description: "Create a page", inputSchema: {} },
];

export async function startFakeOAuthMcp(
  options: FakeOAuthMcpOptions = {},
): Promise<FakeOAuthMcp> {
  const clients = new Map<string, Client>();
  const grants = new Map<string, Grant>();
  const fake = {
    requests: [] as FakeOAuthMcp["requests"],
    registrations: [] as Record<string, unknown>[],
    authorizeQueries: [] as URLSearchParams[],
    tokenRequests: [] as URLSearchParams[],
    validTokens: new Set<string>(),
    validRefreshTokens: new Set<string>(),
  };
  let origin = "";

  const issue = (clientId: string) => {
    const accessToken = `at-${randomBytes(12).toString("hex")}`;
    const refreshToken = `rt-${randomBytes(12).toString("hex")}`;
    fake.validTokens.add(accessToken);
    fake.validRefreshTokens.add(refreshToken);
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: "Bearer",
      expires_in: options.expiresIn ?? 3600,
      client_id: clientId,
    };
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", origin);
    const authorization = req.headers.authorization;
    fake.requests.push({
      method: req.method ?? "GET",
      path: url.pathname,
      ...(authorization ? { authorization } : {}),
    });

    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      json(res, 200, {
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
      });
      return;
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      json(res, 200, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        ...(options.registration === false
          ? {}
          : { registration_endpoint: `${origin}/register` }),
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
      return;
    }
    if (url.pathname === "/register" && req.method === "POST") {
      const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      fake.registrations.push(body);
      const clientId = `client-${randomBytes(6).toString("hex")}`;
      clients.set(clientId, {
        clientId,
        redirectUris: (body.redirect_uris as string[]) ?? [],
      });
      json(res, 201, { ...body, client_id: clientId });
      return;
    }
    if (url.pathname === "/authorize") {
      fake.authorizeQueries.push(url.searchParams);
      const q = url.searchParams;
      const client = clients.get(q.get("client_id") ?? "");
      const redirectUri = q.get("redirect_uri") ?? "";
      if (!client || !client.redirectUris.includes(redirectUri)) {
        json(res, 400, { error: "invalid_request" });
        return;
      }
      const target = new URL(redirectUri);
      const state = q.get("state") ?? "";
      if (options.consent === "deny") {
        target.searchParams.set("error", "access_denied");
        target.searchParams.set("error_description", "The user said no");
        target.searchParams.set("state", state);
      } else {
        const code = `code-${randomBytes(8).toString("hex")}`;
        grants.set(code, {
          clientId: client.clientId,
          redirectUri,
          challenge: q.get("code_challenge") ?? "",
          ...(q.get("resource") ? { resource: q.get("resource")! } : {}),
        });
        target.searchParams.set("code", code);
        target.searchParams.set(
          "state",
          options.consent === "wrong-state" ? `${state}x` : state,
        );
      }
      res.writeHead(302, { location: target.href });
      res.end();
      return;
    }
    if (url.pathname === "/token" && req.method === "POST") {
      const params = new URLSearchParams(await readBody(req));
      fake.tokenRequests.push(params);
      if (options.tokenError) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(options.tokenError(params.get("code") ?? ""));
        return;
      }
      if (params.get("grant_type") === "authorization_code") {
        const grant = grants.get(params.get("code") ?? "");
        const verifier = params.get("code_verifier") ?? "";
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        if (
          !grant ||
          grant.challenge !== challenge ||
          grant.redirectUri !== params.get("redirect_uri") ||
          grant.clientId !== params.get("client_id")
        ) {
          json(res, 400, { error: "invalid_grant" });
          return;
        }
        grants.delete(params.get("code")!);
        json(res, 200, issue(grant.clientId));
        return;
      }
      if (params.get("grant_type") === "refresh_token") {
        const refresh = params.get("refresh_token") ?? "";
        if (!fake.validRefreshTokens.delete(refresh)) {
          json(res, 400, { error: "invalid_grant" });
          return;
        }
        json(res, 200, issue(params.get("client_id") ?? ""));
        return;
      }
      json(res, 400, { error: "unsupported_grant_type" });
      return;
    }
    if (url.pathname === "/mcp") {
      const token = authorization?.replace(/^Bearer /u, "");
      if (!token || !fake.validTokens.has(token)) {
        json(
          res,
          401,
          { error: "unauthorized" },
          {
            "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
          },
        );
        return;
      }
      if (options.redirectMcpTo) {
        res.writeHead(307, { location: options.redirectMcpTo });
        res.end();
        return;
      }
      if (req.method === "DELETE") {
        res.writeHead(204);
        res.end();
        return;
      }
      const message = JSON.parse(await readBody(req)) as {
        id?: number;
        method: string;
      };
      if (message.id === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }
      if (message.method === "initialize") {
        json(res, 200, {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "fake-oauth-mcp", version: "9.9.9" },
          },
        });
        return;
      }
      json(res, 200, {
        jsonrpc: "2.0",
        id: message.id,
        result: { tools: options.tools ?? DEFAULT_TOOLS },
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    server,
    origin,
    url: `${origin}/mcp`,
    ...fake,
    options,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/**
 * Stands in for the user's browser: GETs the authorization URL, then GETs the
 * redirect the server answers with — the loopback callback.
 */
export async function browserApproves(authorizationUrl: string): Promise<void> {
  const authorization = await fetch(authorizationUrl, { redirect: "manual" });
  const location = authorization.headers.get("location");
  if (!location) throw new Error(`authorize answered ${authorization.status}`);
  const callback = await fetch(location);
  await callback.arrayBuffer();
}
