import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { onTestFinished, test } from "vitest";
import { config } from "../../shared/config";
import { database } from "@sourceweft/db";
import { createSourceweftAuth } from "./auth-config";
import { provisionExtensionOAuthClient } from "./extension-oauth-client";

const integrationEnabled = process.env.BETTER_AUTH_RESOURCE_INTEGRATION === "1";

class CookieJar {
  private readonly cookies = new Map<string, string>();

  read(response: Response) {
    const headers = response.headers as Headers & {
      getSetCookie?: () => string[];
    };
    const setCookies = headers.getSetCookie?.() ?? [];
    for (const setCookie of setCookies) {
      const pair = setCookie.split(";", 1)[0];
      const separator = pair?.indexOf("=") ?? -1;
      if (!pair || separator <= 0) {
        continue;
      }

      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      if (value) {
        this.cookies.set(name, value);
      } else {
        this.cookies.delete(name);
      }
    }
  }

  header() {
    return [...this.cookies.entries()]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }
}

function pkce() {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function jwtPayload(token: string) {
  const parts = token.split(".");
  assert.equal(parts.length, 3, "expected a JWT access token");
  return JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as {
    aud?: string | string[];
  };
}

test.skipIf(!integrationEnabled)(
  "binds authorization-code and refresh tokens to the approved resource",
  async () => {
    const auth = createSourceweftAuth({ mode: "migration" });
    await auth.$context;
    await provisionExtensionOAuthClient(database, {
      clientId: config.auth.extensionClientId,
      redirectUri: config.auth.extensionRedirectUri,
      resource: config.auth.baseUrl,
    });

    const alternateResource = `${config.auth.baseUrl}/oauth-resource-binding-${randomUUID()}`;
    await database.query(
      `
        insert into "oauthResource" (
          "id", "identifier", "name", "dpopBoundAccessTokensRequired",
          "disabled", "createdAt", "updatedAt", "policyVersion"
        ) values ($1, $2, $2, false, false, $3, $3, 1)
      `,
      [randomUUID(), alternateResource, new Date()],
    );
    await database.query(
      `
        insert into "oauthClientResource" (
          "id", "clientId", "resourceId", "createdAt"
        ) values ($1, $2, $3, $4)
      `,
      [
        randomUUID(),
        config.auth.extensionClientId,
        alternateResource,
        new Date(),
      ],
    );
    onTestFinished(async () => {
      await database.query(
        `delete from "oauthResource" where "identifier" = $1`,
        [alternateResource],
      );
    });

    const jar = new CookieJar();
    const request = async (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      if (jar.header()) {
        headers.set("cookie", jar.header());
      }
      const response = await auth.handler(
        new Request(`${config.auth.baseUrl}/api/auth${path}`, {
          ...init,
          headers,
        }),
      );
      jar.read(response);
      return response;
    };

    const email = `oauth-resource-${randomUUID()}@sourceweft.test`;
    const signUp = await request("/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "OAuth Resource Test",
        email,
        password: "correct horse battery staple",
      }),
    });
    assert.equal(signUp.status, 200, await signUp.text());

    const authorize = async () => {
      const proof = pkce();
      const query = new URLSearchParams({
        client_id: config.auth.extensionClientId,
        redirect_uri: config.auth.extensionRedirectUri,
        response_type: "code",
        scope: "openid profile email offline_access",
        state: randomUUID(),
        code_challenge: proof.challenge,
        code_challenge_method: "S256",
        resource: config.auth.baseUrl,
      });
      const authorization = await request(`/oauth2/authorize?${query}`, {
        headers: { accept: "application/json" },
      });
      assert.equal(
        authorization.status,
        200,
        await authorization.clone().text(),
      );
      const authorizationBody = (await authorization.json()) as {
        redirect?: boolean;
        url?: string;
      };
      assert.equal(authorizationBody.redirect, true);
      assert.ok(authorizationBody.url);
      const nextUrl = new URL(authorizationBody.url!, config.auth.webBaseUrl);
      let callback = nextUrl;
      if (nextUrl.pathname === "/auth/consent") {
        const consent = await request("/oauth2/consent", {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            accept: true,
            oauth_query: nextUrl.search.slice(1),
          }),
        });
        assert.equal(consent.status, 200, await consent.clone().text());
        const consentBody = (await consent.json()) as {
          redirect?: boolean;
          url?: string;
        };
        assert.equal(consentBody.redirect, true);
        assert.ok(consentBody.url);
        callback = new URL(consentBody.url!);
      }

      assert.equal(
        callback.origin + callback.pathname,
        config.auth.extensionRedirectUri,
      );
      const code = callback.searchParams.get("code");
      assert.ok(code);
      return { code, verifier: proof.verifier };
    };

    const exchange = async (input: {
      code: string;
      verifier: string;
      resource: string;
    }) => {
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        client_id: config.auth.extensionClientId,
        redirect_uri: config.auth.extensionRedirectUri,
        code: input.code,
        code_verifier: input.verifier,
        resource: input.resource,
      });
      return request("/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
    };

    const widenedGrant = await authorize();
    const widenedExchange = await exchange({
      ...widenedGrant,
      resource: alternateResource,
    });
    assert.equal(widenedExchange.status, 400);
    assert.equal(
      ((await widenedExchange.json()) as { error?: string }).error,
      "invalid_target",
    );

    const validGrant = await authorize();
    const validExchange = await exchange({
      ...validGrant,
      resource: config.auth.baseUrl,
    });
    assert.equal(validExchange.status, 200, await validExchange.clone().text());
    const tokens = (await validExchange.json()) as {
      access_token?: string;
      refresh_token?: string;
    };
    assert.ok(tokens.access_token);
    assert.ok(tokens.refresh_token);
    const audience = jwtPayload(tokens.access_token!).aud;
    const audiences = Array.isArray(audience) ? audience : [audience];
    assert.deepEqual(audiences.sort(), [
      config.auth.baseUrl,
      `${config.auth.baseUrl}/api/auth/oauth2/userinfo`,
    ]);

    const widenedRefresh = await request("/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: config.auth.extensionClientId,
        refresh_token: tokens.refresh_token!,
        resource: alternateResource,
      }),
    });
    assert.equal(widenedRefresh.status, 400);
    assert.equal(
      ((await widenedRefresh.json()) as { error?: string }).error,
      "invalid_target",
    );
  },
  30_000,
);
