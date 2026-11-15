import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, test } from "vitest";
import { AUTH_LOCALE_COOKIE, AUTH_LOCALE_HEADER } from "../auth/auth-error-i18n";
import { SSO_ERROR_CODES } from "./errors";
import {
  bootSsoTestHarness,
  closeSsoTestHarness,
  createOrganization,
  signUpUser,
  SsoTestClient,
  type SsoTestHarness,
  type SsoTestUser,
} from "./sso-test-helpers";

/**
 * HTTP-level proof of task 7 (localized SSO errors + SSO rate limits):
 *
 *  - a guard rejection (`/sso/register` with a public email domain) carries
 *    the zh-CN / zh-TW / English message for the same `code`, selected by
 *    `x-sw-locale` (falling back to English with none);
 *  - the official plugin's own `/sign-in/sso` validation errors — reachable
 *    only via a direct `providerId` — are mapped onto our codes and localized
 *    the same way as every other SSO error;
 *  - `/sign-in/sso` keeps its own 10-per-60s rate limit instead of the
 *    built-in `/sign-in/*` default of 3 per 10s.
 */

let harness: SsoTestHarness;
let owner: SsoTestUser;
let orgId: string;
let localeUser: SsoTestUser;

/**
 * A fresh anonymous request to `/sign-in/email` with the wrong password — a
 * handler-level error (`INVALID_EMAIL_OR_PASSWORD`), translated by the
 * official `@better-auth/i18n` plugin. Used as the reference the guard's own
 * (before-hook) locale resolution must agree with for the same request
 * signals (fix round 1, finding 1).
 */
async function wrongPasswordSignIn(headers: Record<string, string>) {
  const client = new SsoTestClient(harness.auth, harness.baseUrl);
  const response = await client.jsonRequest(
    "/sign-in/email",
    { email: localeUser.email, password: "not-the-real-password" },
    { headers },
  );
  return response;
}

/**
 * An AUTHENTICATED request to `/sso/register` with a public email domain — a
 * guard (before-hook) rejection. The admin session is required because the guard
 * now hands an unauthenticated caller straight to the plugin's 401 without
 * running (so the domain rejection would never be reached anonymously); the
 * locale headers still drive the guard's own localization, which is what these
 * tests compare against the handler-level error.
 */
async function authenticatedGuardRejection(headers: Record<string, string>) {
  return registerOidc(owner.client.withFreshIp(), {
    organizationId: orgId,
    domain: "gmail.com",
    headers,
  });
}

function uniqueDomain() {
  return `${randomUUID().slice(0, 8)}.example`;
}

function oidcEndpoints() {
  return {
    authorizationEndpoint: "https://idp.example.com/authorize",
    tokenEndpoint: "https://93.184.216.34/token",
    jwksEndpoint: "https://93.184.216.34/jwks",
  };
}

async function registerOidc(
  client: SsoTestClient,
  input: {
    organizationId: string;
    domain: string;
    locale?: string;
    headers?: Record<string, string>;
  },
) {
  const providerId = `i18n-oidc-${randomUUID()}`;
  const headers = {
    ...(input.locale ? { [AUTH_LOCALE_HEADER]: input.locale } : {}),
    ...input.headers,
  };
  const response = await client.jsonRequest(
    "/sso/register",
    {
      providerId,
      issuer: "https://idp.example.com",
      organizationId: input.organizationId,
      domain: input.domain,
      oidcConfig: {
        clientId: "client-123",
        clientSecret: "s3cr3t",
        tokenEndpointAuthentication: "client_secret_basic",
        skipDiscovery: true,
        scopes: ["openid", "email"],
        ...oidcEndpoints(),
      },
    },
    Object.keys(headers).length > 0 ? { headers } : {},
  );
  return { response, providerId };
}

async function bodyOf(
  response: Response,
): Promise<{ code?: string; message?: string }> {
  return (await response.clone().json()) as { code?: string; message?: string };
}

beforeAll(async () => {
  harness = await bootSsoTestHarness("errori18n");
  owner = await signUpUser(harness, "owner");
  orgId = await createOrganization(harness, {
    ownerUserId: owner.userId,
    kind: "team",
  });
  localeUser = await signUpUser(harness, "localeuser");
}, 600_000);

afterAll(async () => {
  await closeSsoTestHarness(harness);
});

test("a guard rejection localizes to zh-CN via x-sw-locale", async () => {
  const { response } = await registerOidc(owner.client, {
    organizationId: orgId,
    domain: "gmail.com",
    locale: "zh-CN",
  });
  assert.equal(response.status, 400, await response.clone().text());
  const body = await bodyOf(response);
  assert.equal(body.code, SSO_ERROR_CODES.domainNotAllowed);
  assert.equal(body.message, "该域名不能用于单点登录。");
}, 200_000);

test("a guard rejection localizes to zh-TW via x-sw-locale", async () => {
  const { response } = await registerOidc(owner.client, {
    organizationId: orgId,
    domain: "gmail.com",
    locale: "zh-TW",
  });
  assert.equal(response.status, 400, await response.clone().text());
  const body = await bodyOf(response);
  assert.equal(body.code, SSO_ERROR_CODES.domainNotAllowed);
  assert.equal(body.message, "該網域不能用於單一登入。");
}, 200_000);

test("a guard rejection falls back to English with no locale header", async () => {
  const { response } = await registerOidc(owner.client, {
    organizationId: orgId,
    domain: "gmail.com",
  });
  assert.equal(response.status, 400, await response.clone().text());
  const body = await bodyOf(response);
  assert.equal(body.code, SSO_ERROR_CODES.domainNotAllowed);
  assert.equal(body.message, "This domain cannot be used for single sign-on.");
}, 200_000);

test("a guard error and a handler error resolve the SAME locale from Accept-Language alone (fix round 1, finding 1)", async () => {
  const headers = { "Accept-Language": "zh-TW,zh;q=0.9" };
  // Base-language matching (the plugin's own detection) folds both "zh-TW"
  // and "zh" to the bare "zh" key before either gets a chance to look like a
  // region-specific locale — so BOTH resolve to Simplified here, not
  // Traditional. That is the point of this test: before the fix, the guard's
  // own locale resolution used a full negotiator that would have picked
  // "zh-TW" (Traditional) for this header, while the `i18n` plugin picked
  // the bare `zh` (Simplified) for the handler error — same request, two
  // different languages.
  const { response: guardResponse } = await authenticatedGuardRejection(headers);
  assert.equal(guardResponse.status, 400, await guardResponse.clone().text());
  const guardBody = await bodyOf(guardResponse);
  assert.equal(guardBody.code, SSO_ERROR_CODES.domainNotAllowed);
  assert.equal(guardBody.message, "该域名不能用于单点登录。");

  const handlerResponse = await wrongPasswordSignIn(headers);
  assert.equal(handlerResponse.status, 401, await handlerResponse.clone().text());
  const handlerBody = await bodyOf(handlerResponse);
  assert.equal(handlerBody.message, "邮箱或密码无效");
}, 200_000);

test("a guard error and a handler error both go Traditional with x-sw-locale: zh-TW", async () => {
  const headers = { [AUTH_LOCALE_HEADER]: "zh-TW" };
  const { response: guardResponse } = await authenticatedGuardRejection(headers);
  assert.equal(guardResponse.status, 400, await guardResponse.clone().text());
  const guardBody = await bodyOf(guardResponse);
  assert.equal(guardBody.code, SSO_ERROR_CODES.domainNotAllowed);
  assert.equal(guardBody.message, "該網域不能用於單一登入。");

  const handlerResponse = await wrongPasswordSignIn(headers);
  assert.equal(handlerResponse.status, 401, await handlerResponse.clone().text());
  const handlerBody = await bodyOf(handlerResponse);
  assert.equal(handlerBody.message, "郵箱或密碼無效");
}, 200_000);

test("a guard error and a handler error both go Simplified with the sw_locale cookie (no header)", async () => {
  const headers = { cookie: `${AUTH_LOCALE_COOKIE}=zh-CN` };
  const { response: guardResponse } = await authenticatedGuardRejection(headers);
  assert.equal(guardResponse.status, 400, await guardResponse.clone().text());
  const guardBody = await bodyOf(guardResponse);
  assert.equal(guardBody.code, SSO_ERROR_CODES.domainNotAllowed);
  assert.equal(guardBody.message, "该域名不能用于单点登录。");

  const handlerResponse = await wrongPasswordSignIn(headers);
  assert.equal(handlerResponse.status, 401, await handlerResponse.clone().text());
  const handlerBody = await bodyOf(handlerResponse);
  assert.equal(handlerBody.message, "邮箱或密码无效");
}, 200_000);

test("sign-in with an unknown email domain is a localized 404", async () => {
  const client = new SsoTestClient(harness.auth, harness.baseUrl);
  const response = await client.jsonRequest(
    "/sign-in/sso",
    { email: `user@${uniqueDomain()}`, callbackURL: "https://app.example.com/after" },
    { headers: { [AUTH_LOCALE_HEADER]: "zh-CN" } },
  );
  assert.equal(response.status, 404, await response.clone().text());
  const body = await bodyOf(response);
  assert.equal(body.code, SSO_ERROR_CODES.providerNotFound);
  assert.equal(body.message, "该邮箱未配置企业单点登录。");
}, 200_000);

test("sign-in with a providerId of an unverified provider is a localized domain-not-verified error", async () => {
  const { response: registerResponse, providerId } = await registerOidc(owner.client, {
    organizationId: orgId,
    domain: uniqueDomain(),
  });
  assert.equal(registerResponse.status, 200, await registerResponse.clone().text());

  const client = new SsoTestClient(harness.auth, harness.baseUrl);
  const response = await client.jsonRequest(
    "/sign-in/sso",
    { providerId, callbackURL: "https://app.example.com/after" },
    { headers: { [AUTH_LOCALE_HEADER]: "zh-CN" } },
  );
  assert.equal(response.status, 401, await response.clone().text());
  const body = await bodyOf(response);
  assert.equal(body.code, SSO_ERROR_CODES.domainNotVerified);
  assert.equal(body.message, "该域名尚未完成验证，请联系管理员完成配置。");
}, 200_000);

test("sign-in with a nonexistent providerId is a localized provider-not-found error", async () => {
  const client = new SsoTestClient(harness.auth, harness.baseUrl);
  const response = await client.jsonRequest(
    "/sign-in/sso",
    {
      providerId: `missing-${randomUUID()}`,
      callbackURL: "https://app.example.com/after",
    },
    { headers: { [AUTH_LOCALE_HEADER]: "zh-CN" } },
  );
  assert.equal(response.status, 404, await response.clone().text());
  const body = await bodyOf(response);
  assert.equal(body.code, SSO_ERROR_CODES.providerNotFound);
  assert.equal(body.message, "该邮箱未配置企业单点登录。");
}, 200_000);

test("/sign-in/sso's own 100-per-60s rule is the one in effect, not the built-in 3-per-10s default", async () => {
  // Two cheaper proofs instead of issuing 100+1 full requests:
  //  1. The resolved rate-limit context (what `onRequestRateLimit` actually
  //     reads, not a re-derivation of it) carries our rule for this path.
  const context = (await harness.auth.$context) as unknown as {
    rateLimit: { customRules?: Record<string, { window: number; max: number }> };
  };
  assert.deepEqual(context.rateLimit.customRules?.["/sign-in/sso"], {
    window: 60,
    max: 100,
  });
  //  2. A live check too small for the built-in `/sign-in/*` default (3 per
  //     10s) to allow: if that default — not our rule — were in effect, the
  //     4th of these (well within 10s) would already be a 429.
  const client = new SsoTestClient(harness.auth, harness.baseUrl);
  const statuses: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    const response = await client.jsonRequest("/sign-in/sso", {
      email: `user@${uniqueDomain()}`,
      callbackURL: "https://app.example.com/after",
    });
    statuses.push(response.status);
  }
  assert.equal(
    statuses.every((status) => status !== 429),
    true,
    `expected no 429 in 4 requests (the built-in 3/10s default would reject the 4th), got ${JSON.stringify(statuses)}`,
  );
}, 200_000);
