import assert from "node:assert/strict";
import { isAPIError } from "better-auth/api";
import { test } from "vitest";
import { SSO_ERROR_CODES } from "./errors";
import {
  isVerifiedDomainUniqueViolation,
  VERIFIED_DOMAIN_UNIQUE_INDEX,
  wrapAdapterForVerifiedDomainUniqueness,
} from "./guard-plugin";

/**
 * The exact error the better-auth kysely adapter surfaces when the partial
 * unique index is violated, captured from a real database run (a PostgreSQL
 * `DatabaseError`: fields on the error itself, no wrapping `cause`).
 */
function verifiedDomainUniqueViolation() {
  return Object.assign(
    new Error(
      `duplicate key value violates unique constraint "${VERIFIED_DOMAIN_UNIQUE_INDEX}"`,
    ),
    {
      name: "error",
      severity: "ERROR",
      code: "23505",
      detail: "Key (domain)=(acme.com) already exists.",
      constraint: VERIFIED_DOMAIN_UNIQUE_INDEX,
    },
  );
}

test("isVerifiedDomainUniqueViolation matches the real verified-domain violation", () => {
  assert.equal(
    isVerifiedDomainUniqueViolation(verifiedDomainUniqueViolation()),
    true,
  );
});

test("isVerifiedDomainUniqueViolation ignores a 23505 for a different constraint", () => {
  const otherConstraint = Object.assign(
    new Error(
      'duplicate key value violates unique constraint "ssoProvider_providerId_unique"',
    ),
    { code: "23505", constraint: "ssoProvider_providerId_unique" },
  );
  assert.equal(isVerifiedDomainUniqueViolation(otherConstraint), false);
});

test("isVerifiedDomainUniqueViolation ignores a non-unique-violation error", () => {
  // Same SQLSTATE family would be wrong to match; a check constraint (23514)
  // even if it mentioned the index name is not a unique violation.
  const notUnique = Object.assign(
    new Error('relation "ssoProvider" does not exist'),
    { code: "42P01" },
  );
  assert.equal(isVerifiedDomainUniqueViolation(notUnique), false);
});

test("isVerifiedDomainUniqueViolation rejects non-Error values", () => {
  assert.equal(isVerifiedDomainUniqueViolation("boom"), false);
  assert.equal(isVerifiedDomainUniqueViolation(null), false);
  assert.equal(isVerifiedDomainUniqueViolation(undefined), false);
  assert.equal(isVerifiedDomainUniqueViolation(23505), false);
});

test("the wrapper also detects the violation nested under `cause`", () => {
  // Defensive: a future adapter version may wrap the driver error.
  const wrapped = Object.assign(new Error("adapter failure"), {
    cause: verifiedDomainUniqueViolation(),
  });
  assert.equal(isVerifiedDomainUniqueViolation(wrapped), true);
});

test("the wrapper maps the violation to a 400 and preserves the cause", async () => {
  const adapter = wrapAdapterForVerifiedDomainUniqueness({
    incrementOne: async (_args: { model?: string }) => {
      throw verifiedDomainUniqueViolation();
    },
  });
  const error = await adapter
    .incrementOne({ model: "ssoProvider" })
    .then(() => null, (thrown: unknown) => thrown);

  assert.ok(isAPIError(error), `expected an APIError, got ${String(error)}`);
  assert.equal(error.statusCode, 400);
  assert.equal(error.body?.code, SSO_ERROR_CODES.domainNotAllowed);
  // The originating DB error is preserved on the (non-enumerable) cause.
  assert.equal((error.cause as { code?: string } | undefined)?.code, "23505");
});

test("the wrapper rethrows an unrelated error unchanged", async () => {
  const boom = new Error("boom");
  const adapter = wrapAdapterForVerifiedDomainUniqueness({
    incrementOne: async (_args: { model?: string }) => {
      throw boom;
    },
  });
  const error = await adapter
    .incrementOne({ model: "ssoProvider" })
    .then(() => null, (thrown: unknown) => thrown);

  assert.equal(error, boom);
  assert.equal(isAPIError(error), false);
});

test("the wrapper does not map a violation for a different model", async () => {
  const adapter = wrapAdapterForVerifiedDomainUniqueness({
    incrementOne: async (_args: { model?: string }) => {
      throw verifiedDomainUniqueViolation();
    },
  });
  const error = await adapter
    .incrementOne({ model: "user" })
    .then(() => null, (thrown: unknown) => thrown);

  assert.equal(isAPIError(error), false);
});
