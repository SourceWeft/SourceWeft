import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { test } from "vitest";
import {
  AppleTokenError,
  createAppleClientSecret,
  exchangeAppleAuthorizationCode,
  revokeAppleRefreshToken,
} from "./apple-tokens";

const { privateKey, publicKey } = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
});
const settings = {
  appBundleId: "nicelab.sourceweft.mobile",
  teamId: "TEAM123456",
  keyId: "KEY1234567",
  privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
};

function decode(part: string) {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

function idToken(claims: Record<string, unknown>) {
  return `${Buffer.from("{}").toString("base64url")}.${Buffer.from(
    JSON.stringify(claims),
  ).toString("base64url")}.sig`;
}

type Call = { url: string; form: URLSearchParams };

function fakeFetch(
  respond: (call: Call) => { status: number; body: unknown } | Error,
) {
  const calls: Call[] = [];
  const fetchImpl = async (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string },
  ) => {
    assert.equal(init.method, "POST");
    assert.equal(
      init.headers["content-type"],
      "application/x-www-form-urlencoded",
    );
    const call = { url, form: new URLSearchParams(init.body) };
    calls.push(call);
    const result = respond(call);
    if (result instanceof Error) throw result;
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      json: async () => result.body,
    };
  };
  return { fetchImpl, calls };
}

test("the client secret is an ES256 JWT Apple can verify, for this app and team", () => {
  const now = 1_800_000_000;
  const jwt = createAppleClientSecret(settings, now);
  const [header, payload, signature] = jwt.split(".");
  assert.deepEqual(decode(header!), { alg: "ES256", kid: "KEY1234567" });
  assert.deepEqual(decode(payload!), {
    iss: "TEAM123456",
    iat: now,
    exp: now + 300,
    aud: "https://appleid.apple.com",
    sub: "nicelab.sourceweft.mobile",
  });
  assert.equal(
    verify(
      "sha256",
      Buffer.from(`${header}.${payload}`),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(signature!, "base64url"),
    ),
    true,
  );
});

test("an authorization code is exchanged for a refresh token and the Apple user id", async () => {
  const { fetchImpl, calls } = fakeFetch(() => ({
    status: 200,
    body: {
      access_token: "access",
      refresh_token: "refresh-1",
      id_token: idToken({ sub: "001234.abcd.0001" }),
    },
  }));
  const result = await exchangeAppleAuthorizationCode(
    settings,
    "code-1",
    fetchImpl,
  );
  assert.deepEqual(result, {
    refreshToken: "refresh-1",
    subject: "001234.abcd.0001",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://appleid.apple.com/auth/token");
  assert.equal(calls[0]!.form.get("client_id"), "nicelab.sourceweft.mobile");
  assert.equal(calls[0]!.form.get("code"), "code-1");
  assert.equal(calls[0]!.form.get("grant_type"), "authorization_code");
  assert.equal(calls[0]!.form.get("client_secret")!.split(".").length, 3);
});

test("a token response without a refresh token or user id is an error", async () => {
  for (const body of [
    { id_token: idToken({ sub: "user" }) },
    { refresh_token: "refresh-1", id_token: idToken({}) },
    { refresh_token: "refresh-1", id_token: "not-a-jwt" },
    null,
  ]) {
    const { fetchImpl } = fakeFetch(() => ({ status: 200, body }));
    await assert.rejects(
      exchangeAppleAuthorizationCode(settings, "code-1", fetchImpl),
      (error: unknown) =>
        error instanceof AppleTokenError && error.reason === "invalid_response",
    );
  }
});

test("Apple refusing a code is a rejected error that names Apple's reason, never the code", async () => {
  const { fetchImpl } = fakeFetch(() => ({
    status: 400,
    body: { error: "invalid_grant" },
  }));
  await assert.rejects(
    exchangeAppleAuthorizationCode(settings, "secret-code-value", fetchImpl),
    (error: unknown) => {
      assert.ok(error instanceof AppleTokenError);
      assert.equal(error.reason, "invalid_grant");
      assert.equal(error.status, 400);
      assert.equal(error.rejected, true);
      assert.ok(!error.message.includes("secret-code-value"));
      return true;
    },
  );
});

test("an unreachable or failing Apple is not a rejection, so the caller can retry", async () => {
  const offline = fakeFetch(() => new Error("ECONNRESET"));
  await assert.rejects(
    revokeAppleRefreshToken(settings, "refresh-1", offline.fetchImpl),
    (error: unknown) =>
      error instanceof AppleTokenError &&
      error.reason === "network" &&
      error.status === 0 &&
      !error.rejected,
  );
  const failing = fakeFetch(() => ({ status: 503, body: "unavailable" }));
  await assert.rejects(
    revokeAppleRefreshToken(settings, "refresh-1", failing.fetchImpl),
    (error: unknown) =>
      error instanceof AppleTokenError &&
      error.status === 503 &&
      !error.rejected,
  );
});

test("revoking sends the refresh token with its type hint to Apple's revoke endpoint", async () => {
  const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: {} }));
  await revokeAppleRefreshToken(settings, "refresh-1", fetchImpl);
  assert.equal(calls[0]!.url, "https://appleid.apple.com/auth/revoke");
  assert.equal(calls[0]!.form.get("client_id"), "nicelab.sourceweft.mobile");
  assert.equal(calls[0]!.form.get("token"), "refresh-1");
  assert.equal(calls[0]!.form.get("token_type_hint"), "refresh_token");
  assert.ok(calls[0]!.form.get("client_secret"));
});
