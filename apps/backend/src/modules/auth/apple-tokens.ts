import { createPrivateKey, sign } from "node:crypto";

/**
 * Calls to Apple's Sign in with Apple token service for the native iOS app:
 * exchanging the authorization code the app receives for a refresh token, and
 * revoking that token when the account is deleted (App Store guideline
 * 5.1.1(v)). The client id is the app's bundle id; the client secret is a
 * short-lived ES256 JWT signed with the Sign in with Apple key.
 *
 * Nothing here logs or returns token values in errors.
 */

export type AppleKeySettings = {
  appBundleId: string;
  teamId: string;
  keyId: string;
  privateKey: string;
};

type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

const APPLE_AUDIENCE = "https://appleid.apple.com";
const TOKEN_URL = "https://appleid.apple.com/auth/token";
const REVOKE_URL = "https://appleid.apple.com/auth/revoke";
// Apple accepts up to six months; a few minutes is all one request needs.
const CLIENT_SECRET_TTL_SECONDS = 300;

export class AppleTokenError extends Error {
  constructor(
    message: string,
    /** Apple's `error` value, or "network"/"invalid_response". */
    readonly reason: string,
    /** HTTP status from Apple, 0 when no response arrived. */
    readonly status: number,
  ) {
    super(message);
    this.name = "AppleTokenError";
  }

  /** Apple refused the request itself; retrying with the same input fails again. */
  get rejected() {
    return this.status >= 400 && this.status < 500;
  }
}

function base64Url(input: Buffer | string) {
  return Buffer.from(input).toString("base64url");
}

/** The client_secret Apple's token endpoints require: an ES256 JWT. */
export function createAppleClientSecret(
  settings: AppleKeySettings,
  nowSeconds = Math.floor(Date.now() / 1000),
) {
  const header = { alg: "ES256", kid: settings.keyId };
  const payload = {
    iss: settings.teamId,
    iat: nowSeconds,
    exp: nowSeconds + CLIENT_SECRET_TTL_SECONDS,
    aud: APPLE_AUDIENCE,
    sub: settings.appBundleId,
  };
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(
    JSON.stringify(payload),
  )}`;
  const signature = sign("sha256", Buffer.from(signingInput), {
    key: createPrivateKey(settings.privateKey),
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${base64Url(signature)}`;
}

async function postForm(
  fetchImpl: FetchLike,
  url: string,
  form: Record<string, string>,
  action: string,
) {
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    });
  } catch {
    throw new AppleTokenError(
      `Apple could not be reached to ${action}.`,
      "network",
      0,
    );
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: unknown;
    } | null;
    const reason = typeof body?.error === "string" ? body.error : "unknown";
    throw new AppleTokenError(
      `Apple refused to ${action} (${response.status} ${reason}).`,
      reason,
      response.status,
    );
  }
  return response;
}

function subjectOf(idToken: unknown) {
  if (typeof idToken !== "string") return null;
  const payload = idToken.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as {
      sub?: unknown;
    };
    return typeof claims.sub === "string" && claims.sub ? claims.sub : null;
  } catch {
    return null;
  }
}

/**
 * Exchange the authorization code from a native Sign in with Apple for a
 * refresh token. The ID token in the response comes straight from Apple over
 * TLS, so its `sub` (the Apple user id) is read without verifying a signature.
 */
export async function exchangeAppleAuthorizationCode(
  settings: AppleKeySettings,
  code: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
) {
  const response = await postForm(
    fetchImpl,
    TOKEN_URL,
    {
      client_id: settings.appBundleId,
      client_secret: createAppleClientSecret(settings),
      code,
      grant_type: "authorization_code",
    },
    "exchange the authorization code",
  );
  const body = (await response.json().catch(() => null)) as {
    refresh_token?: unknown;
    id_token?: unknown;
  } | null;
  const subject = subjectOf(body?.id_token);
  if (
    typeof body?.refresh_token !== "string" ||
    !body.refresh_token ||
    !subject
  ) {
    throw new AppleTokenError(
      "Apple's token response had no refresh token or user id.",
      "invalid_response",
      response.status,
    );
  }
  return { refreshToken: body.refresh_token, subject };
}

/** Revoke a refresh token, which ends the app's access to that Apple ID. */
export async function revokeAppleRefreshToken(
  settings: AppleKeySettings,
  refreshToken: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
) {
  await postForm(
    fetchImpl,
    REVOKE_URL,
    {
      client_id: settings.appBundleId,
      client_secret: createAppleClientSecret(settings),
      token: refreshToken,
      token_type_hint: "refresh_token",
    },
    "revoke the token",
  );
}
