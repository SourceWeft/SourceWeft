import assert from "node:assert/strict";
import { test } from "vitest";
import { rejectUnsupportedOAuthResource } from "./oauth-resource-guard";

async function rejected(request: Request) {
  const response = await rejectUnsupportedOAuthResource(request);
  assert.ok(response);
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("pragma"), "no-cache");
  assert.deepEqual(await response.json(), {
    error: "invalid_target",
    error_description: "OAuth resource indicators are not supported.",
  });
}

test("rejects a resource query on the authorization endpoint", async () => {
  await rejected(
    new Request(
      "https://api.sourceweft.test/api/auth/oauth2/authorize?resource=https%3A%2F%2Fother.example",
    ),
  );
});

test("rejects form-encoded resources on the token endpoint", async () => {
  await rejected(
    new Request("https://api.sourceweft.test/api/auth/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=refresh_token&resource=https%3A%2F%2Fother.example",
    }),
  );
});

test("rejects JSON resources on the token endpoint", async () => {
  await rejected(
    new Request("https://api.sourceweft.test/api/auth/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        resource: "https://other.example",
      }),
    }),
  );
});

test("allows supported token requests without consuming the body", async () => {
  const request = new Request(
    "https://api.sourceweft.test/api/auth/oauth2/token",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=refresh_token&refresh_token=token-1",
    },
  );

  assert.equal(await rejectUnsupportedOAuthResource(request), null);
  assert.equal(
    await request.text(),
    "grant_type=refresh_token&refresh_token=token-1",
  );
});

test("does not apply the OAuth guard to unrelated auth endpoints", async () => {
  const request = new Request(
    "https://api.sourceweft.test/api/auth/sign-in/email?resource=profile",
    { method: "POST" },
  );

  assert.equal(await rejectUnsupportedOAuthResource(request), null);
});

test("leaves malformed JSON to Better Auth when no resource can be read", async () => {
  const request = new Request(
    "https://api.sourceweft.test/api/auth/oauth2/token",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    },
  );

  assert.equal(await rejectUnsupportedOAuthResource(request), null);
});
