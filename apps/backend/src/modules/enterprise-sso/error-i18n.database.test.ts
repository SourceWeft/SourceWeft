import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, test } from "vitest";
import { AUTH_LOCALE_HEADER } from "../auth/auth-error-i18n";
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
  input: { organizationId: string; domain: string; locale?: string },
) {
  const providerId = `i18n-oidc-${randomUUID()}`;
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
    input.locale ? { headers: { [AUTH_LOCALE_HEADER]: input.locale } } : {},
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

test("/sign-in/sso allows 10 requests per 60s from one IP and rejects the 11th", async () => {
  const client = new SsoTestClient(harness.auth, harness.baseUrl);
  const statuses: number[] = [];
  for (let i = 0; i < 11; i += 1) {
    const response = await client.jsonRequest("/sign-in/sso", {
      email: `user@${uniqueDomain()}`,
      callbackURL: "https://app.example.com/after",
    });
    statuses.push(response.status);
  }
  assert.equal(
    statuses.slice(0, 10).every((status) => status !== 429),
    true,
    `expected no 429 in the first 10 requests, got ${JSON.stringify(statuses)}`,
  );
  assert.equal(
    statuses[10],
    429,
    `expected the 11th request to be rate-limited, got ${JSON.stringify(statuses)}`,
  );
}, 200_000);
