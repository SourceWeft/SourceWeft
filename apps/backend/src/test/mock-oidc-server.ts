import {
  createSign,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A throwaway OpenID Connect identity provider for the enterprise-SSO database
 * tests. It implements just enough of the protocol for `@better-auth/sso`'s
 * OIDC sign-in to complete end to end against a real HTTP server:
 *
 *  - `GET /.well-known/openid-configuration` — discovery document;
 *  - `GET /authorize` — immediately 302s back to the caller's `redirect_uri`
 *    with a `code` and the original `state` (no login UI);
 *  - `POST /token` — returns an access token and an RS256-signed `id_token`;
 *  - `GET /jwks` — the signing key as a JWK set;
 *  - `GET /userinfo` — the configured claims.
 *
 * The RS256 id_token and the JWKS are built with `node:crypto` only — `jose`
 * is not a dependency of the backend and none is added for this. The server
 * binds to `127.0.0.1` on an ephemeral port; its origin must be added to the
 * test auth instance's `trustedOrigins`, because the plugin's SSRF guard
 * rejects a loopback endpoint otherwise (the documented escape hatch for an
 * internal IdP). This is test-only and never reaches production config.
 */

/** Claims the IdP asserts, returned in both the id_token and `/userinfo`. */
export type MockOidcClaims = Record<string, unknown> & {
  sub: string;
  email: string;
};

export type MockOidcServer = {
  /** Base URL / issuer, e.g. `http://127.0.0.1:54321`. */
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Replace the claims the next sign-in will assert. */
  setClaims: (claims: MockOidcClaims) => void;
  close: () => Promise<void>;
};

const KEY_ID = "mock-oidc-key-1";
const ID_TOKEN_TTL_SECONDS = 300;

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** Sign a compact RS256 JWT with `node:crypto` (no `jose`). */
function signRs256Jwt(
  payload: Record<string, unknown>,
  privateKey: KeyObject,
): string {
  const header = { alg: "RS256", typ: "JWT", kid: KEY_ID };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(
    JSON.stringify(payload),
  )}`;
  const signature = createSign("RSA-SHA256")
    .update(signingInput)
    .sign(privateKey);
  return `${signingInput}.${base64url(signature)}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** Start a mock OIDC IdP on 127.0.0.1 and return its coordinates. */
export async function startMockOidcServer(input?: {
  claims?: MockOidcClaims;
}): Promise<MockOidcServer> {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwk = publicKey.export({ format: "jwk" });
  const jwks = {
    keys: [{ ...jwk, kid: KEY_ID, use: "sig", alg: "RS256" }],
  };

  const clientId = `mock-client-${randomBytes(6).toString("hex")}`;
  const clientSecret = `mock-secret-${randomBytes(12).toString("hex")}`;

  let claims: MockOidcClaims = input?.claims ?? {
    sub: "mock-user",
    email: "mock-user@example.com",
    email_verified: true,
    name: "Mock User",
  };

  // Assigned once the socket is listening and the port is known.
  let issuer = "";

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? "/", issuer);

    if (req.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
      sendJson(res, 200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        userinfo_endpoint: `${issuer}/userinfo`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: [
          "client_secret_basic",
          "client_secret_post",
        ],
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/authorize") {
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      if (!redirectUri) {
        sendJson(res, 400, { error: "invalid_request" });
        return;
      }
      const target = new URL(redirectUri);
      target.searchParams.set("code", `mock-code-${randomBytes(8).toString("hex")}`);
      if (state !== null) {
        target.searchParams.set("state", state);
      }
      res.writeHead(302, { location: target.toString() });
      res.end();
      return;
    }

    if (req.method === "POST" && url.pathname === "/token") {
      // The authorization code is not validated: this IdP has one identity at a
      // time, set via `setClaims`, and always returns it.
      const now = Math.floor(Date.now() / 1000);
      const idToken = signRs256Jwt(
        {
          iss: issuer,
          aud: clientId,
          iat: now,
          exp: now + ID_TOKEN_TTL_SECONDS,
          ...claims,
        },
        privateKey,
      );
      // Drain the request body so the socket closes cleanly.
      req.resume();
      sendJson(res, 200, {
        access_token: `mock-access-${randomBytes(8).toString("hex")}`,
        token_type: "Bearer",
        expires_in: ID_TOKEN_TTL_SECONDS,
        id_token: idToken,
        scope: "openid email profile",
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/jwks") {
      sendJson(res, 200, jwks);
      return;
    }

    if (req.method === "GET" && url.pathname === "/userinfo") {
      sendJson(res, 200, { ...claims });
      return;
    }

    sendJson(res, 404, { error: "not_found" });
  };

  const server: Server = createServer((req, res) => {
    try {
      handle(req, res);
    } catch {
      if (!res.headersSent) {
        sendJson(res, 500, { error: "server_error" });
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  issuer = `http://127.0.0.1:${address.port}`;

  return {
    issuer,
    clientId,
    clientSecret,
    setClaims: (next: MockOidcClaims) => {
      claims = next;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
