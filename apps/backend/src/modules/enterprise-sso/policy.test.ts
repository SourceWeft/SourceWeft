import assert from "node:assert/strict";
import { expect, test } from "vitest";
import { SSO_ERROR_CODES } from "./errors";
import {
  assertSsoDomainAllowed,
  isPublicEmailDomain,
  normalizeSsoDomain,
  ssoDomainCandidates,
} from "./policy";

/** An error carrying the better-auth `APIError` body shape. */
function hasDomainNotAllowedCode(error: unknown): boolean {
  const body = (error as { body?: { code?: unknown } }).body;
  return body?.code === SSO_ERROR_CODES.domainNotAllowed;
}

test("normalizeSsoDomain trims, lowercases, drops a trailing dot and a leading @", () => {
  expect(normalizeSsoDomain("  ACME.com. ")).toBe("acme.com");
  expect(normalizeSsoDomain("@acme.com")).toBe("acme.com");
});

test("normalizeSsoDomain rejects values that are not bare hostnames", () => {
  expect(() => normalizeSsoDomain("not a domain")).toThrow();
  expect(() => normalizeSsoDomain("acme.com/path")).toThrow();
  expect(() => normalizeSsoDomain("acme")).toThrow();
  expect(() => normalizeSsoDomain("acme.com:8080")).toThrow();
  expect(() => normalizeSsoDomain("")).toThrow();
});

test("normalizeSsoDomain lowercases and punycodes an internationalized domain", () => {
  expect(normalizeSsoDomain("BÜCHER.example")).toBe("xn--bcher-kva.example");
});

test("normalizeSsoDomain keeps a subdomain distinct from its parent (Review Focus 3)", () => {
  expect(normalizeSsoDomain("mail.acme.com")).toBe("mail.acme.com");
});

test("isPublicEmailDomain recognizes shared consumer providers, not private ones", () => {
  expect(isPublicEmailDomain("gmail.com")).toBe(true);
  expect(isPublicEmailDomain("qq.com")).toBe(true);
  expect(isPublicEmailDomain("outlook.com")).toBe(true);
  expect(isPublicEmailDomain("163.com")).toBe(true);
  expect(isPublicEmailDomain("acme.com")).toBe(false);
});

test("assertSsoDomainAllowed rejects a public email domain", async () => {
  await assert.rejects(
    assertSsoDomainAllowed(
      { domain: "gmail.com", organizationId: "org-a" },
      async () => [],
    ),
    hasDomainNotAllowedCode,
  );
});

test("assertSsoDomainAllowed rejects a domain VERIFIED by another organization", async () => {
  const lookup = async () => [
    {
      providerId: "p-b",
      organizationId: "org-b",
      domain: "acme.com",
      domainVerified: true,
    },
  ];
  await assert.rejects(
    assertSsoDomainAllowed({ domain: "acme.com", organizationId: "org-a" }, lookup),
    hasDomainNotAllowedCode,
  );
});

test("assertSsoDomainAllowed allows a domain only UNVERIFIED-claimed by another organization", async () => {
  const lookup = async () => [
    {
      providerId: "p-b",
      organizationId: "org-b",
      domain: "acme.com",
      domainVerified: false,
    },
  ];
  // An unverified squatter must not block the real owner from registering.
  await assert.doesNotReject(
    assertSsoDomainAllowed({ domain: "acme.com", organizationId: "org-a" }, lookup),
  );
});

test("assertSsoDomainAllowed rejects a second provider for the same domain in the same organization", async () => {
  const lookup = async () => [
    {
      providerId: "sibling",
      organizationId: "org-a",
      domain: "acme.com",
      domainVerified: false,
    },
  ];
  await assert.rejects(
    assertSsoDomainAllowed({ domain: "acme.com", organizationId: "org-a" }, lookup),
    hasDomainNotAllowedCode,
  );
});

test("assertSsoDomainAllowed treats a parent and its subdomain as different domains (Review Focus 3)", async () => {
  const lookup = async () => [
    {
      providerId: "p-b",
      organizationId: "org-b",
      domain: "mail.acme.com",
      domainVerified: true,
    },
  ];
  // The exact subdomain verified by another org is a conflict...
  await assert.rejects(
    assertSsoDomainAllowed(
      { domain: "mail.acme.com", organizationId: "org-a" },
      lookup,
    ),
    hasDomainNotAllowedCode,
  );
  // ...but the parent domain is a distinct domain and must be allowed.
  await assert.doesNotReject(
    assertSsoDomainAllowed({ domain: "acme.com", organizationId: "org-a" }, lookup),
  );
});

test("assertSsoDomainAllowed ignores the excluded provider when it is the row being updated", async () => {
  const lookup = async () => [
    {
      providerId: "self",
      organizationId: "org-a",
      domain: "acme.com",
      domainVerified: true,
    },
  ];
  await assert.doesNotReject(
    assertSsoDomainAllowed(
      { domain: "acme.com", organizationId: "org-a", excludeProviderId: "self" },
      lookup,
    ),
  );
});

test("ssoDomainCandidates walks parents up to the registrable domain", () => {
  assert.deepEqual(ssoDomainCandidates("acme.com"), ["acme.com"]);
  assert.deepEqual(ssoDomainCandidates("mail.acme.com"), [
    "mail.acme.com",
    "acme.com",
  ]);
  assert.deepEqual(ssoDomainCandidates("a.b.acme.com"), [
    "a.b.acme.com",
    "b.acme.com",
    "acme.com",
  ]);
  // Never ascends into the public suffix.
  assert.deepEqual(ssoDomainCandidates("gmail.com"), ["gmail.com"]);
});
