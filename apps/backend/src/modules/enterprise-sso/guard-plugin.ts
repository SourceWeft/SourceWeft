import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { socialProviderList } from "@better-auth/core/social-providers";
import { logger } from "../../shared/logger";
import { authErrorTranslations, resolveGuardErrorLocale } from "../auth/auth-error-i18n";
import {
  recordSsoProviderChangeAfterHook,
  SSO_AUDIT_PATHS,
  snapshotSsoProviderForAudit,
} from "./audit";
import { SSO_ERROR_CODES, ssoError, ssoErrorRedirect } from "./errors";
import {
  assertSsoDomainAllowed,
  assertTeamOrganization,
  normalizeSsoDomain,
  ssoDomainCandidates,
  type SsoProviderDomainLookup,
  type SsoProviderDomainRow,
} from "./policy";
import { assertSamlResponseAlgorithmsAllowed } from "./saml-algorithm-policy";
import { SSO_ROLE_CLAIM_KEY, validateRoleAttribute } from "./role-mapping";
import {
  recordSsoCreatedUser,
  recordSsoSignInSession,
} from "./sso-sign-in-capture";

/**
 * Tenant-policy guard for `@better-auth/sso`, wired in next to the plugin from
 * sso-plugin.ts. The official plugin already rejects non-members (400) and
 * non-admins (403), hides other organizations' providers, and SSRF-checks OIDC
 * endpoints. This guard adds the SourceWeft rules the plugin cannot know, maps
 * the plugin's own errors to localized codes, and records the per-request facts
 * provisioning needs:
 *
 *  - register/update (before-hook): a provider id must match
 *    {@link PROVIDER_ID_PATTERN}; a provider must belong to a `team`
 *    organization; its domain is normalized, must be private (no public mailbox
 *    provider, no bare public suffix), unique within its organization, and not
 *    verified by another organization. A team is capped at
 *    {@link MAX_PROVIDERS_PER_ORGANIZATION} providers; a SAML provider always
 *    stores `wantAssertionsSigned: true`; a role attribute is carried into the
 *    config's mapping (seeded from the stored mapping on a partial update). These
 *    rules run for EVERY caller — however they authenticate — and the plugin's
 *    own sessionMiddleware answers 401 for an unauthenticated one afterwards.
 *  - verify-domain (before-hook): a domain already verified by another
 *    organization cannot be verified again; a partial unique index backstops the
 *    check against races (see {@link VERIFIED_DOMAIN_UNIQUE_INDEX}).
 *  - sign-in (before-hook): an `organizationSlug` with no providerId resolves to
 *    the org's single verified provider; otherwise email/domain sign-in routes to
 *    the exact verified provider, else the nearest verified parent domain, making
 *    unverified squatter rows invisible. No match is a 404.
 *  - SAML ACS (before-hook): a response declaring a disallowed signature/digest
 *    algorithm, or an encrypted assertion, is rejected before the plugin verifies
 *    it (see ./saml-algorithm-policy.ts).
 *  - delete (before-hook): snapshots the row for the audit after-hook.
 *  - after-hooks: record the provider-lifecycle audit entry (best-effort), and
 *    map the plugin's own sign-in / identity-locked errors onto localized codes.
 *  - init: installs the verified-domain unique-violation adapter wrapper, marks
 *    an SSO-created user email-verified, and captures (for ./provisioning.ts)
 *    which user/session this sign-in created.
 *
 * Before-hook rejections throw a better-auth `APIError` whose JSON body `code` is
 * the matching {@link SSO_ERROR_CODES} value, localized in place.
 */

const REGISTER_PATH = "/sso/register";
const UPDATE_PATH = "/sso/update-provider";
const DELETE_PATH = "/sso/delete-provider";
const VERIFY_DOMAIN_PATH = "/sso/verify-domain";
const SIGN_IN_PATH = "/sign-in/sso";
/**
 * The only plugin endpoint that consumes a `SAMLResponse` to SIGN A USER IN, and
 * so the only one the algorithm policy below guards. Enumerated against the
 * `@better-auth/sso@1.7.7` dist: the OIDC callbacks (`/sso/callback`,
 * `/sso/callback/:providerId`) take an authorization `code`, never a SAML POST;
 * the SLO endpoints (`/sso/saml2/sp/slo/:providerId`, `/sso/saml2/logout/:providerId`)
 * consume a SAML LogoutRequest/Response for sign-OUT, not sign-in, and Single
 * Logout is disabled (`enableSingleLogout: false`), so neither can establish a
 * session — the algorithm gate is a sign-in defence and does not apply there.
 */
const SAML_ACS_PATH = "/sso/saml2/sp/acs/:providerId";
const SSO_PROVIDER_MODEL = "ssoProvider";
const SSO_PROVIDER_ORGANIZATION_MODEL = "organization";

/**
 * The SSO sign-in callback / SAML ACS routes. Membership provisioning runs after
 * these commit a session; a provisioning failure throws its own error-URL
 * redirect from inside `provisionUser` (see ./provisioning.ts). A user created on
 * these paths is marked email-verified here (its domain was proven by the
 * resolver), and the captures below record which user/session this sign-in made.
 * Matched by the endpoint's route pattern, as the other hooks are.
 */
const SSO_CALLBACK_PATHS = new Set([
  "/sso/callback",
  "/sso/callback/:providerId",
  "/sso/saml2/sp/acs/:providerId",
]);

function isSsoCallbackPath(path: unknown): boolean {
  return typeof path === "string" && SSO_CALLBACK_PATHS.has(path);
}

// Default profile-mapping claim names, used to fill `mapping.email`/`mapping.name`
// when a before-hook injects a role claim into a config that carried no mapping,
// so the plugin's (strict) mapping schema still validates.
const SAML_NAME_MAPPING_DEFAULT = "displayName";
const OIDC_NAME_MAPPING_DEFAULT = "name";
const EMAIL_MAPPING_DEFAULT = "email";

/**
 * Maximum SSO providers one organization may own. The plugin's `providersLimit`
 * caps providers per registering user; this caps them per tenant.
 */
export const MAX_PROVIDERS_PER_ORGANIZATION = 5;

/**
 * Allowed provider-id shape at registration. The domain-verification TXT record
 * is `_sourceweft-sso-<providerId>` (a 16-char prefix), and a DNS label caps at
 * 63 chars, so an id over 47 chars could never be verified. The label charset is
 * also narrower than a general string, so we fix it to lowercase letters, digits
 * and hyphens. The provider id is immutable, so this is enforced at creation.
 */
export const PROVIDER_ID_PATTERN = /^[a-z0-9-]{3,47}$/;

/**
 * Provider ids better-auth already uses as account `providerId`s: its built-in
 * social providers plus the password `credential` provider. Deleting a provider
 * removes `account` rows by providerId (lifecycle.ts), so a provider registered
 * under one of these ids would, once that social provider is enabled, sweep real
 * accounts — so they are rejected at registration. `okta` and other
 * generic-OAuth / SAML names are NOT here (they are plausible SSO ids).
 */
const RESERVED_PROVIDER_IDS = new Set<string>([
  ...socialProviderList,
  "credential",
]);
export function isReservedProviderId(providerId: string): boolean {
  return RESERVED_PROVIDER_IDS.has(providerId.toLowerCase());
}

/**
 * Name of the partial unique index (added by a SQL migration) that enforces one
 * verified provider per domain across all organizations. A write that violates
 * it is mapped to {@link SSO_ERROR_CODES.domainNotAllowed} instead of a 500.
 */
export const VERIFIED_DOMAIN_UNIQUE_INDEX = "sso_provider_verified_domain_unique";

/** The narrow slice of the better-auth adapter this guard reads. */
type GuardAdapter = {
  findMany: (args: {
    model: string;
    where?: Array<{ field: string; value: unknown; operator?: string }>;
    select?: string[];
  }) => Promise<Array<Record<string, unknown>>>;
  findOne: (args: {
    model: string;
    where?: Array<{ field: string; value: unknown }>;
    select?: string[];
  }) => Promise<Record<string, unknown> | null>;
};

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toDomainRow(row: Record<string, unknown>): SsoProviderDomainRow {
  return {
    providerId: String(row.providerId ?? ""),
    organizationId: asString(row.organizationId),
    domain: String(row.domain ?? ""),
    domainVerified: row.domainVerified === true,
  };
}

/** Lookup of existing providers sharing a domain, backed by the auth adapter. */
function domainLookup(adapter: GuardAdapter): SsoProviderDomainLookup {
  return async (domain) => {
    const rows = await adapter.findMany({
      model: SSO_PROVIDER_MODEL,
      where: [{ field: "domain", value: domain }],
      select: ["providerId", "organizationId", "domain", "domainVerified"],
    });
    return rows.map(toDomainRow);
  };
}

/** Force `samlConfig.wantAssertionsSigned` to true when a SAML config is present. */
function withSignedAssertions(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const samlConfig = body.samlConfig;
  if (!samlConfig || typeof samlConfig !== "object") {
    return body;
  }
  return {
    ...body,
    samlConfig: {
      ...(samlConfig as Record<string, unknown>),
      wantAssertionsSigned: true,
    },
  };
}

/** The domain part after the last `@`, or null for a value without one. */
function emailDomain(email: string | null): string | null {
  if (!email) {
    return null;
  }
  const at = email.lastIndexOf("@");
  if (at < 0) {
    return null;
  }
  const domain = email.slice(at + 1);
  return domain.length > 0 ? domain : null;
}

/**
 * Validate the body's role attribute. Returns the trimmed attribute to carry,
 * or `null` when the provider sets none (or clears it — an empty value leaves the
 * existing mapping untouched). A present-but-invalid attribute (over-long or with
 * control characters) is rejected with
 * {@link SSO_ERROR_CODES.invalidRoleAttribute}. Any claim name is allowed — the
 * guard maps it into a namespaced key, so it cannot touch a user column.
 */
function roleAttributeFromBody(body: Record<string, unknown>): string | null {
  const raw = body.roleAttribute;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return null;
  }
  const result = validateRoleAttribute(raw);
  if (!result.ok) {
    throw ssoError(SSO_ERROR_CODES.invalidRoleAttribute, "BAD_REQUEST");
  }
  return result.value;
}

function asMapping(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? { ...(value as object) } : {};
}

/**
 * Carry the role claim into a config's `mapping.extraFields` under the FIXED,
 * namespaced {@link SSO_ROLE_CLAIM_KEY} (never the tenant's attribute name, which
 * could be a user column), so the IdP's `roleAttribute` claim reaches `userInfo`
 * as `ssoRoleClaim` and role mapping reads it there. The plugin drops that key
 * from the user row (it is not a user field). Existing mapping is preserved;
 * `email`/`name` are defaulted so the (strict) mapping schema still validates.
 * When the role attribute changes the same key is overwritten; it carries no
 * stale role fields.
 */
function withRoleExtraField(
  providerConfig: Record<string, unknown>,
  roleAttribute: string,
  kind: "oidc" | "saml",
): Record<string, unknown> {
  const existing = asMapping(providerConfig.mapping);
  const extraFields = {
    ...asMapping(existing.extraFields),
    [SSO_ROLE_CLAIM_KEY]: roleAttribute,
  };
  return {
    ...providerConfig,
    mapping: {
      ...existing,
      email: typeof existing.email === "string" ? existing.email : EMAIL_MAPPING_DEFAULT,
      name:
        typeof existing.name === "string"
          ? existing.name
          : kind === "saml"
            ? SAML_NAME_MAPPING_DEFAULT
            : OIDC_NAME_MAPPING_DEFAULT,
      extraFields,
    },
  };
}

/**
 * Strip the namespaced role claim ({@link SSO_ROLE_CLAIM_KEY}) from a config's
 * `mapping.extraFields` — used when a provider's role attribute is cleared (or
 * was never set), so the stored mapping stops copying a role claim. Other
 * extra-field mappings are preserved; `email`/`name` are defaulted so the strict
 * mapping schema still validates.
 */
function withoutRoleExtraField(
  providerConfig: Record<string, unknown>,
  kind: "oidc" | "saml",
): Record<string, unknown> {
  const existing = asMapping(providerConfig.mapping);
  const extraFields = { ...asMapping(existing.extraFields) };
  delete extraFields[SSO_ROLE_CLAIM_KEY];
  const mapping: Record<string, unknown> = {
    ...existing,
    email: typeof existing.email === "string" ? existing.email : EMAIL_MAPPING_DEFAULT,
    name:
      typeof existing.name === "string"
        ? existing.name
        : kind === "saml"
          ? SAML_NAME_MAPPING_DEFAULT
          : OIDC_NAME_MAPPING_DEFAULT,
  };
  if (Object.keys(extraFields).length > 0) {
    mapping.extraFields = extraFields;
  } else {
    delete mapping.extraFields;
  }
  return { ...providerConfig, mapping };
}

/**
 * When an update body carries a provider config but no `mapping`, seed the
 * mapping from the STORED config's mapping before the role claim is injected. The
 * plugin merges a provider config's mapping whole (`updates.mapping ??
 * current.mapping`), so a combined update like `{ oidcConfig: { scopes },
 * roleAttribute }` — which {@link withRoleExtraField} would otherwise turn into a
 * defaults-only mapping — would drop a custom `mapping.email`/`name` set earlier.
 * An explicit `mapping` in the body wins.
 */
function seedMappingFromStored(
  bodyConfig: Record<string, unknown>,
  storedConfig: unknown,
): Record<string, unknown> {
  if (bodyConfig.mapping && typeof bodyConfig.mapping === "object") {
    return bodyConfig;
  }
  const stored = storedConfigMapping(storedConfig);
  if (Object.keys(stored).length === 0) {
    return bodyConfig;
  }
  return { ...bodyConfig, mapping: stored };
}

/** The `mapping` object stored inside a provider's oidcConfig/samlConfig column. */
function storedConfigMapping(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return asMapping((JSON.parse(value) as { mapping?: unknown }).mapping);
    } catch {
      return {};
    }
  }
  if (value && typeof value === "object") {
    return asMapping((value as { mapping?: unknown }).mapping);
  }
  return {};
}

/**
 * The resolved set of `user`-table field names — core fields, the
 * `user.additionalFields` from auth-config, and any user fields plugins add —
 * derived from the auth options the same way better-auth's own
 * `getFields(options, "user", …)` does, and memoized per options object. These
 * are the keys a provider's `mapping.extraFields` must never use: a matching key
 * would let the IdP write that user column at sign-in (or run a plugin's
 * `user.create` hook — e.g. username validation — inside the sign-in
 * transaction).
 */
const userFieldCache = new WeakMap<object, Set<string>>();
function resolvedUserFieldNames(options: unknown): Set<string> {
  if (options && typeof options === "object" && userFieldCache.has(options)) {
    return userFieldCache.get(options)!;
  }
  const names = new Set<string>([
    "id",
    "email",
    "emailVerified",
    "name",
    "image",
    "createdAt",
    "updatedAt",
  ]);
  const opts = (options ?? {}) as {
    user?: { additionalFields?: Record<string, unknown> };
    plugins?: Array<{ schema?: Record<string, { fields?: Record<string, unknown> }> }>;
  };
  for (const key of Object.keys(opts.user?.additionalFields ?? {})) {
    names.add(key);
  }
  for (const plugin of opts.plugins ?? []) {
    const fields = plugin?.schema?.user?.fields;
    if (fields) {
      for (const key of Object.keys(fields)) {
        names.add(key);
      }
    }
  }
  if (options && typeof options === "object") {
    userFieldCache.set(options, names);
  }
  return names;
}

/**
 * Reject a provider config whose `mapping.extraFields` uses a key that is a user
 * field (see {@link resolvedUserFieldNames}). Our own namespaced role claim
 * ({@link SSO_ROLE_CLAIM_KEY}) is never a user field, so it always passes.
 */
function assertSafeExtraFields(config: unknown, userFields: Set<string>): void {
  if (!config || typeof config !== "object") {
    return;
  }
  const mapping = (config as { mapping?: unknown }).mapping;
  if (!mapping || typeof mapping !== "object") {
    return;
  }
  const extraFields = (mapping as { extraFields?: unknown }).extraFields;
  if (!extraFields || typeof extraFields !== "object") {
    return;
  }
  for (const key of Object.keys(extraFields)) {
    if (userFields.has(key)) {
      throw ssoError(SSO_ERROR_CODES.invalidAttributeMapping, "BAD_REQUEST");
    }
  }
}

/** Inject the role claim into the registration body's oidc/saml mapping. */
function applyRegisterRoleMapping(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const roleAttribute = roleAttributeFromBody(body);
  if (!roleAttribute) {
    return body;
  }
  if (body.oidcConfig && typeof body.oidcConfig === "object") {
    return {
      ...body,
      oidcConfig: withRoleExtraField(
        body.oidcConfig as Record<string, unknown>,
        roleAttribute,
        "oidc",
      ),
    };
  }
  if (body.samlConfig && typeof body.samlConfig === "object") {
    return {
      ...body,
      samlConfig: withRoleExtraField(
        body.samlConfig as Record<string, unknown>,
        roleAttribute,
        "saml",
      ),
    };
  }
  return body;
}

/** The before-hook context slice the handlers read (body + resolved options). */
type GuardHandlerCtx = {
  body?: Record<string, unknown>;
  context?: { options?: unknown };
};

async function handleRegister(ctx: GuardHandlerCtx, adapter: GuardAdapter) {
  const body = ctx.body as Record<string, unknown>;
  const providerId = asString(body.providerId);
  if (!providerId || !PROVIDER_ID_PATTERN.test(providerId) || isReservedProviderId(providerId)) {
    throw ssoError(SSO_ERROR_CODES.invalidProviderId, "BAD_REQUEST");
  }
  const organizationId = asString(body.organizationId);
  if (!organizationId) {
    throw ssoError(SSO_ERROR_CODES.organizationRequired, "BAD_REQUEST");
  }
  await assertTeamOrganization(organizationId);

  const existing = await adapter.findMany({
    model: SSO_PROVIDER_MODEL,
    where: [{ field: "organizationId", value: organizationId }],
    select: ["providerId"],
  });
  if (existing.length >= MAX_PROVIDERS_PER_ORGANIZATION) {
    throw ssoError(SSO_ERROR_CODES.providerLimit, "BAD_REQUEST");
  }

  const domain = normalizeSsoDomain(String(body.domain ?? ""));
  await assertSsoDomainAllowed({ domain, organizationId }, domainLookup(adapter));

  const userFields = resolvedUserFieldNames(ctx.context?.options);
  assertSafeExtraFields(body.oidcConfig, userFields);
  assertSafeExtraFields(body.samlConfig, userFields);

  return {
    context: {
      body: withSignedAssertions(applyRegisterRoleMapping({ ...body, domain })),
    },
  };
}

async function handleUpdate(ctx: GuardHandlerCtx, adapter: GuardAdapter) {
  const body = ctx.body as Record<string, unknown>;
  const userFields = resolvedUserFieldNames(ctx.context?.options);
  const providerId = asString(body.providerId);
  const nextBody: Record<string, unknown> = { ...body };

  if (typeof body.domain === "string") {
    const domain = normalizeSsoDomain(body.domain);
    const current = providerId
      ? await adapter.findOne({
          model: SSO_PROVIDER_MODEL,
          where: [{ field: "providerId", value: providerId }],
          select: ["providerId", "organizationId", "domain"],
        })
      : null;
    const organizationId = asString(current?.organizationId);
    // An org-less provider cannot be re-domained here: the plugin's
    // guardProviderMutation rejects the mutation outright. For a team-owned
    // provider, enforce the same domain policy as register, excluding itself.
    if (organizationId) {
      await assertSsoDomainAllowed(
        { domain, organizationId, excludeProviderId: providerId ?? undefined },
        domainLookup(adapter),
      );
    }
    nextBody.domain = domain;
  }

  // Keep the stored `roleAttribute` column and the mapping's `ssoRoleClaim` in
  // sync so they never drift. The attribute name lives in the column (what the
  // plugin reads to decide `roleManaged`); the mapping carries
  // `extraFields.ssoRoleClaim = <that name>` so the IdP's claim reaches
  // `userInfo`. We touch the config whenever the update body changes the role
  // attribute OR sends a config (whose `mapping`, if present, would otherwise
  // replace the stored one whole and drop the claim).
  const hasRoleAttributeInBody = Object.prototype.hasOwnProperty.call(
    body,
    "roleAttribute",
  );
  const bodyRoleAttribute = roleAttributeFromBody(body); // throws on invalid
  const bodyHasOidc = Boolean(body.oidcConfig && typeof body.oidcConfig === "object");
  const bodyHasSaml = Boolean(body.samlConfig && typeof body.samlConfig === "object");

  if (providerId && (hasRoleAttributeInBody || bodyHasOidc || bodyHasSaml)) {
    const current = await adapter.findOne({
      model: SSO_PROVIDER_MODEL,
      where: [{ field: "providerId", value: providerId }],
      // organizationId is required so the secret-storage adapter wrapper can
      // resolve the team key when it decrypts the stored config on read.
      select: ["organizationId", "oidcConfig", "samlConfig", "roleAttribute"],
    });
    // An explicit body value — a new name, or a clear (null/empty → null) — wins;
    // otherwise the stored column is preserved, so a mapping-only edit keeps the
    // role claim instead of dropping it.
    const effectiveRoleAttribute = hasRoleAttributeInBody
      ? bodyRoleAttribute
      : asString(current?.roleAttribute);

    const applyClaim = (
      config: Record<string, unknown>,
      kind: "oidc" | "saml",
    ): Record<string, unknown> =>
      effectiveRoleAttribute
        ? withRoleExtraField(config, effectiveRoleAttribute, kind)
        : withoutRoleExtraField(config, kind);

    if (bodyHasOidc) {
      nextBody.oidcConfig = applyClaim(
        seedMappingFromStored(
          body.oidcConfig as Record<string, unknown>,
          current?.oidcConfig,
        ),
        "oidc",
      );
    } else if (bodyHasSaml) {
      nextBody.samlConfig = applyClaim(
        seedMappingFromStored(
          body.samlConfig as Record<string, unknown>,
          current?.samlConfig,
        ),
        "saml",
      );
    } else if (current?.oidcConfig) {
      // roleAttribute-only update (set or clear): patch the stored mapping.
      nextBody.oidcConfig = applyClaim(
        { mapping: storedConfigMapping(current.oidcConfig) },
        "oidc",
      );
    } else if (current?.samlConfig) {
      nextBody.samlConfig = applyClaim(
        { mapping: storedConfigMapping(current.samlConfig) },
        "saml",
      );
    }
  }

  // Validate the FINAL mapping the guard will send (body merged with what it
  // seeds from the stored row), not just the body's own, so a user-field
  // extra-field cannot slip in through the stored mapping either.
  assertSafeExtraFields(nextBody.oidcConfig, userFields);
  assertSafeExtraFields(nextBody.samlConfig, userFields);

  return { context: { body: withSignedAssertions(nextBody) } };
}

async function handleVerifyDomain(
  ctx: { body?: Record<string, unknown>; context: object },
  adapter: GuardAdapter,
) {
  const providerId = asString(ctx.body?.providerId);
  if (!providerId) {
    return; // the plugin validates the body / 404s a missing provider
  }
  const current = await adapter.findOne({
    model: SSO_PROVIDER_MODEL,
    where: [{ field: "providerId", value: providerId }],
    select: ["providerId", "organizationId", "domain"],
  });
  if (!current) {
    return;
  }
  // Snapshot before the DNS check, regardless of outcome: the endpoint's own
  // 204 success response carries no body, so the after-hook audit entry can
  // only come from here. A rejection below throws out of this before-hook,
  // which skips after-hooks entirely, so the snapshot is simply never read.
  await snapshotSsoProviderForAudit(ctx, adapter, providerId);
  const organizationId = asString(current.organizationId);
  const domain = String(current.domain ?? "").toLowerCase();
  if (!domain) {
    return;
  }
  const rows = await domainLookup(adapter)(domain);
  const conflict = rows.some(
    (row) =>
      row.domain === domain &&
      row.domainVerified &&
      row.organizationId !== null &&
      row.organizationId !== organizationId,
  );
  if (conflict) {
    throw ssoError(SSO_ERROR_CODES.domainNotAllowed, "BAD_REQUEST");
  }
}

async function handleSignInRouting(
  ctx: { body?: Record<string, unknown> },
  adapter: GuardAdapter,
) {
  const body = ctx.body as Record<string, unknown> | undefined;
  if (!body) {
    return;
  }
  // The caller named a provider directly: nothing to resolve.
  if (asString(body.providerId)) {
    return;
  }
  // A slug with no providerId: resolve it to the org's single verified provider,
  // so the plugin never picks an arbitrary or unverified row for the slug.
  const organizationSlug = asString(body.organizationSlug);
  if (organizationSlug) {
    return resolveSlugToVerifiedProvider(body, organizationSlug, adapter);
  }
  const raw = asString(body.domain) ?? emailDomain(asString(body.email));
  if (!raw) {
    return; // nothing to resolve from; let the plugin handle it
  }

  let domain: string;
  try {
    domain = normalizeSsoDomain(raw);
  } catch {
    throw ssoError(SSO_ERROR_CODES.providerNotFound, "NOT_FOUND");
  }

  const candidates = ssoDomainCandidates(domain);
  const rows = await adapter.findMany({
    model: SSO_PROVIDER_MODEL,
    where: [
      { field: "domain", value: candidates, operator: "in" },
      { field: "domainVerified", value: true },
    ],
    select: ["providerId", "domain", "domainVerified"],
  });

  // Exact match first, then the nearest verified parent domain.
  for (const candidate of candidates) {
    const match = rows.find(
      (row) => String(row.domain) === candidate && row.domainVerified === true,
    );
    if (match) {
      return {
        context: { body: { ...body, providerId: String(match.providerId) } },
      };
    }
  }

  throw ssoError(SSO_ERROR_CODES.providerNotFound, "NOT_FOUND");
}

/**
 * Resolve `/sign-in/sso` with an `organizationSlug` and no `providerId` to the
 * organization's single VERIFIED provider. Given only a slug, the plugin would
 * select the first `ssoProvider` row for the org — possibly unverified, and
 * arbitrary among several — so the guard decides it instead: exactly one
 * verified provider routes to it; an unknown slug, or zero or several verified
 * providers, is a 404 `SSO_PROVIDER_NOT_FOUND` (the web then falls back to the
 * email form).
 */
async function resolveSlugToVerifiedProvider(
  body: Record<string, unknown>,
  organizationSlug: string,
  adapter: GuardAdapter,
) {
  const organization = await adapter.findOne({
    model: SSO_PROVIDER_ORGANIZATION_MODEL,
    where: [{ field: "slug", value: organizationSlug }],
    select: ["id"],
  });
  const organizationId = organization ? asString(organization.id) : null;
  if (!organizationId) {
    throw ssoError(SSO_ERROR_CODES.providerNotFound, "NOT_FOUND");
  }
  const verified = await adapter.findMany({
    model: SSO_PROVIDER_MODEL,
    where: [
      { field: "organizationId", value: organizationId },
      { field: "domainVerified", value: true },
    ],
    select: ["providerId"],
  });
  if (verified.length !== 1) {
    throw ssoError(SSO_ERROR_CODES.providerNotFound, "NOT_FOUND");
  }
  return {
    context: {
      body: { ...body, providerId: String(verified[0]!.providerId) },
    },
  };
}

/**
 * The official plugin's own messages for `/sign-in/sso`, thrown deep inside
 * its handler (not reachable through a `matcher`/before-hook) when the caller
 * names a `providerId` or `organizationSlug` directly: a missing provider id
 * ("No provider found for the issuer") or one whose domain never verified
 * ("Provider domain has not been verified"). `handleSignInRouting` above
 * already covers every other case (an email/domain lookup that resolves or
 * 404s), so these two are the only paths left where the plugin's own
 * unmapped text could reach a caller.
 */
const PLUGIN_SIGN_IN_PROVIDER_NOT_FOUND_MESSAGE = "No provider found for the issuer";
const PLUGIN_SIGN_IN_DOMAIN_NOT_VERIFIED_MESSAGE =
  "Provider domain has not been verified";

/** The narrow after-hook context this guard reads/replaces `context.returned` on. */
type AfterHookCtx = {
  path?: string;
  context: { returned?: unknown };
};

/**
 * `/sign-in/sso` after-hook: maps the plugin's own validation errors (above)
 * onto {@link SSO_ERROR_CODES}, so the i18n plugin (registered last) can
 * localize them like every other SSO error.
 *
 * An after-hook replaces the response by *throwing* the new `APIError` —
 * mirroring `@better-auth/i18n`'s own after-hook, the proven way to do this
 * — which `dispatchAuthEndpoint`'s `runAfterHooks` catches and installs as
 * `context.returned`. Confirmed against better-auth@1.7.7: an after-hook
 * cannot change the HTTP *status* this way — the status returned to the
 * caller is fixed from the *first* thrown error, before any after-hook
 * runs — only the body's `code`/`message`. That is harmless here: the
 * plugin's own statuses (404 for a missing provider, 401 for an unverified
 * domain) already match what the rest of this guard uses for the same codes
 * (`SSO_PROVIDER_NOT_FOUND` is a 404 in {@link handleSignInRouting} too).
 */
function mapSignInSsoPluginError(ctx: AfterHookCtx): void {
  const returned = ctx.context.returned;
  if (!(returned instanceof APIError)) {
    return;
  }
  if (returned.message === PLUGIN_SIGN_IN_PROVIDER_NOT_FOUND_MESSAGE) {
    throw ssoError(SSO_ERROR_CODES.providerNotFound, "NOT_FOUND");
  }
  if (returned.message === PLUGIN_SIGN_IN_DOMAIN_NOT_VERIFIED_MESSAGE) {
    throw ssoError(SSO_ERROR_CODES.domainNotVerified, "UNAUTHORIZED");
  }
}

/**
 * The plugin's own 409 when an update changes a provider's identity fields
 * (issuer, OIDC client id/endpoints, SAML certificate / entity id / sign-on URL)
 * after any account has linked through it (dist index.mjs ~L2428). It carries a
 * message but no `code`, so — like the sign-in errors above — the guard's
 * after-hook re-throws it under {@link SSO_ERROR_CODES.providerIdentityLocked}
 * (also a 409, so the status is unchanged) and the i18n plugin localizes it.
 */
const PLUGIN_UPDATE_IDENTITY_LOCKED_MESSAGE =
  "Cannot change SSO provider identity fields while linked accounts exist";

function mapUpdateProviderIdentityLock(ctx: AfterHookCtx): void {
  const returned = ctx.context.returned;
  if (
    returned instanceof APIError &&
    returned.message === PLUGIN_UPDATE_IDENTITY_LOCKED_MESSAGE
  ) {
    throw ssoError(SSO_ERROR_CODES.providerIdentityLocked, "CONFLICT");
  }
}

/**
 * Runs a before-hook body, re-throwing any `APIError` it raises with a
 * localized `message` for the same `code`.
 *
 * better-auth's `i18n` plugin (registered last, see auth-config.ts) only
 * ever localizes an error thrown from *inside* an endpoint handler: its
 * after-hook reads `ctx.context.returned`, which `dispatchAuthEndpoint` only
 * populates from the handler's own `.catch`. A before-hook's throw (where
 * every validation in this guard lives — `handleRegister`, `handleUpdate`,
 * `handleVerifyDomain`, `handleSignInRouting`, and the policy helpers they
 * call) escapes `dispatchAuthEndpoint` before any after-hook gets a chance to
 * run (confirmed against better-auth@1.7.7's `runBeforeHooks`, which only
 * logs and re-throws). So a before-hook must localize its own errors — and
 * must resolve the locale the exact same way the `i18n` plugin would for a
 * handler-level error, via {@link resolveGuardErrorLocale} (not an
 * independent negotiator — see that function's doc comment for why one
 * request could otherwise get two different languages for two SSO errors).
 */
async function withLocalizedGuardErrors<T>(
  headers: Headers | null | undefined,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof APIError && typeof error.body?.code === "string") {
      const code = error.body.code;
      const locale = resolveGuardErrorLocale(headers);
      const messages = authErrorTranslations[locale] as Record<
        string,
        string | undefined
      >;
      const translated = messages[code];
      if (translated) {
        throw new APIError(error.status, { code, message: translated });
      }
    }
    throw error;
  }
}

/**
 * Whether an error is the verified-domain unique-index violation
 * ({@link VERIFIED_DOMAIN_UNIQUE_INDEX}). The PostgreSQL unique violation
 * surfaces through the better-auth kysely adapter; its fields (`code`,
 * `constraint`, `detail`, `message`) may sit on the error itself or on its
 * `cause`, so both layers are inspected. A non-object / non-Error value, a
 * different SQLSTATE, or a 23505 for another constraint all return false.
 */
export function isVerifiedDomainUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const layers = [error, (error as { cause?: unknown }).cause].filter(
    (layer): layer is Record<string, unknown> =>
      typeof layer === "object" && layer !== null,
  );
  if (!layers.some((layer) => layer.code === "23505")) {
    return false;
  }
  return layers.some((layer) =>
    `${layer.constraint ?? ""} ${layer.detail ?? ""} ${layer.message ?? ""}`.includes(
      VERIFIED_DOMAIN_UNIQUE_INDEX,
    ),
  );
}

type TransactionRunner = <R>(callback: (trx: object) => Promise<R>) => Promise<R>;

/**
 * Wrap the adapter so that a unique-index violation from setting a provider's
 * `domainVerified` surfaces as a clean {@link SSO_ERROR_CODES.domainNotAllowed}
 * instead of a 500 — the race-safe backstop for two concurrent verifications of
 * the same domain.
 *
 * The only write that sets `domainVerified` true is `incrementOne` in the
 * plugin's `completeDomainVerification`, which in `@better-auth/sso@1.7.7` runs
 * OUTSIDE a transaction (it is called with `ctx.context.adapter` directly, not a
 * transaction adapter). The `transaction` method is re-wrapped anyway — mirroring
 * {@link ../secret-storage}'s adapter wrapper — so the mapping still applies if a
 * future plugin version moves verification inside `adapter.transaction(...)`.
 */
export function wrapAdapterForVerifiedDomainUniqueness<T extends object>(
  adapter: T,
): T {
  const base = adapter as {
    incrementOne?: (args: { model?: string }) => Promise<unknown>;
    transaction?: TransactionRunner;
  };
  if (typeof base.incrementOne !== "function") {
    return adapter;
  }
  return new Proxy(adapter, {
    get(target, property, receiver) {
      if (property === "incrementOne") {
        return async (args: { model?: string }) => {
          try {
            return await base.incrementOne!(args);
          } catch (error) {
            if (
              args?.model === SSO_PROVIDER_MODEL &&
              isVerifiedDomainUniqueViolation(error)
            ) {
              const rejection = ssoError(
                SSO_ERROR_CODES.domainNotAllowed,
                "BAD_REQUEST",
              );
              // Keep the originating DB error for diagnostics/tests without
              // leaking it in the serialized response body: a non-enumerable
              // `cause` is skipped by JSON.stringify.
              Object.defineProperty(rejection, "cause", {
                value: error,
                enumerable: false,
                configurable: true,
              });
              throw rejection;
            }
            throw error;
          }
        };
      }
      if (property === "transaction") {
        const runTransaction = base.transaction;
        if (typeof runTransaction !== "function") {
          return Reflect.get(target, property, receiver);
        }
        return <R>(callback: (trx: object) => Promise<R>): Promise<R> =>
          runTransaction((trx) =>
            callback(wrapAdapterForVerifiedDomainUniqueness(trx)),
          );
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

/**
 * `user.create` before-hook: a user created on an SSO callback path is marked
 * email-verified. Its email domain was proven by `resolveUser` (which rejects a
 * mismatch before any user is created) together with the provider's verified
 * domain, so the account is verified at creation — without trusting the IdP's
 * own `email_verified` claim and without the sign-up verification mail the
 * plugin would otherwise dispatch for an unverified new account. Non-SSO user
 * creation is left untouched.
 */
function markSsoCreatedUserVerified(
  user: { emailVerified?: unknown },
  context: { path?: unknown } | null | undefined,
): { data: { emailVerified: true } } | undefined {
  if (!isSsoCallbackPath(context?.path) || user.emailVerified === true) {
    return undefined;
  }
  return { data: { emailVerified: true } };
}

/**
 * SAML ACS before-hook: reject a sign-in whose response declares a signature or
 * digest algorithm outside the allow-list, or an encrypted assertion, BEFORE the
 * plugin verifies and accepts it (see ./saml-algorithm-policy.ts for why the
 * plugin itself does not enforce this on the POST binding). On rejection it
 * throws the shared 302-to-error-URL redirect carrying
 * {@link SSO_ERROR_CODES.samlAlgorithmNotAllowed} — exactly how a failed SAML
 * callback is surfaced — so no session cookie is set and nothing is created. A
 * request with no `SAMLResponse` (the GET post-auth redirect, or a malformed
 * POST) is left to the plugin.
 */
function assertSamlAcsAlgorithms(ctx: {
  body?: { SAMLResponse?: unknown } | null;
  params?: { providerId?: unknown };
}): void {
  const samlResponse = ctx.body?.SAMLResponse;
  if (samlResponse === undefined || samlResponse === null) {
    return;
  }
  const result = assertSamlResponseAlgorithmsAllowed(samlResponse);
  if (!result.ok) {
    // The reason is a closed enum of policy codes — never claim or assertion
    // content — so it is safe to log alongside the provider id.
    logger.warn("sso_saml_algorithm_rejected", {
      providerId: asString(ctx.params?.providerId) ?? undefined,
      reason: result.reason,
    });
    throw ssoErrorRedirect(SSO_ERROR_CODES.samlAlgorithmNotAllowed, result.reason);
  }
}

export function sourceweftSsoGuard(): BetterAuthPlugin {
  return {
    id: "sourceweft-sso-guard",
    init(ctx) {
      return {
        context: {
          adapter: wrapAdapterForVerifiedDomainUniqueness(ctx.adapter),
        },
        options: {
          databaseHooks: {
            user: {
              create: {
                before: async (
                  user: { emailVerified?: unknown },
                  context: { path?: unknown } | null,
                ) => markSsoCreatedUserVerified(user, context),
                // Record that THIS sign-in created the user row (keyed by the
                // request's endpoint context), so provisioning can set the
                // `sso.sign_in` audit's `isNewUser` correctly even when the
                // plugin signs an existing SSO account in under a changed IdP
                // email. Runs (and is awaited) after the sign-in transaction
                // commits but before `provisionUser`.
                after: async (
                  _user: { id?: unknown },
                  context: { path?: unknown } | null,
                ) => {
                  if (context && isSsoCallbackPath(context.path)) {
                    recordSsoCreatedUser(context);
                  }
                },
              },
            },
            session: {
              create: {
                // Capture the exact session this sign-in created (keyed by the
                // request's endpoint context), so a failed membership step
                // revokes only it. Only SSO-callback sessions are captured; a
                // concurrent password sign-in's session is on another path and
                // in another endpoint context.
                after: async (
                  session: { id?: unknown; userId?: unknown },
                  context: { path?: unknown } | null,
                ) => {
                  if (
                    context &&
                    isSsoCallbackPath(context.path) &&
                    asString(session.id)
                  ) {
                    recordSsoSignInSession(context, String(session.id));
                  }
                },
              },
            },
          },
        },
      };
    },
    hooks: {
      before: [
        {
          matcher: (context) =>
            context.path === REGISTER_PATH || context.path === UPDATE_PATH,
          handler: createAuthMiddleware(async (ctx) =>
            // The guard runs for EVERY caller, however they authenticate (cookie,
            // bearer token, API key…): its tenant rules must never be skipped by
            // how a request carries its credentials. The plugin's own
            // sessionMiddleware answers 401 for an unauthenticated caller after
            // these rules have run.
            withLocalizedGuardErrors(ctx.headers, async () => {
              if (!ctx.body) {
                return;
              }
              const adapter = ctx.context.adapter as unknown as GuardAdapter;
              return ctx.path === REGISTER_PATH
                ? handleRegister(ctx, adapter)
                : handleUpdate(ctx, adapter);
            }),
          ),
        },
        {
          matcher: (context) => context.path === VERIFY_DOMAIN_PATH,
          handler: createAuthMiddleware(async (ctx) =>
            withLocalizedGuardErrors(ctx.headers, async () => {
              const adapter = ctx.context.adapter as unknown as GuardAdapter;
              return handleVerifyDomain(ctx, adapter);
            }),
          ),
        },
        {
          matcher: (context) => context.path === SIGN_IN_PATH,
          handler: createAuthMiddleware(async (ctx) =>
            withLocalizedGuardErrors(ctx.headers, async () => {
              const adapter = ctx.context.adapter as unknown as GuardAdapter;
              return handleSignInRouting(ctx, adapter);
            }),
          ),
        },
        {
          // Reject deprecated SAML signature/digest algorithms (and encrypted
          // assertions) before the plugin verifies the response, since it does
          // not enforce the algorithm on the POST binding.
          matcher: (context) => context.path === SAML_ACS_PATH,
          handler: createAuthMiddleware(async (ctx) => {
            assertSamlAcsAlgorithms(
              ctx as {
                body?: { SAMLResponse?: unknown };
                params?: { providerId?: unknown };
              },
            );
          }),
        },
        {
          // The deleted row is gone by the time an after-hook could read it,
          // so snapshot it here for the audit log (see ./audit.ts).
          matcher: (context) => context.path === DELETE_PATH,
          handler: createAuthMiddleware(async (ctx) => {
            const providerId = asString(ctx.body?.providerId);
            if (!providerId) {
              return;
            }
            const adapter = ctx.context.adapter as unknown as GuardAdapter;
            await snapshotSsoProviderForAudit(ctx, adapter, providerId);
          }),
        },
      ],
      after: [
        {
          matcher: (context) =>
            !!context.path &&
            (SSO_AUDIT_PATHS as readonly string[]).includes(context.path),
          handler: createAuthMiddleware(async (ctx) => {
            // Best-effort: the register/update/delete/verify has already
            // committed, so an audit-write failure must not turn it into a 500.
            try {
              await recordSsoProviderChangeAfterHook(ctx);
            } catch (error) {
              const body = ctx.body as Record<string, unknown> | undefined;
              const returned = ctx.context?.returned as
                | Record<string, unknown>
                | undefined;
              logger.error("sso_provider_change_audit_failed", {
                path: ctx.path,
                reason: "audit_failed",
                providerId:
                  asString(body?.providerId) ??
                  asString(returned?.providerId) ??
                  undefined,
                organizationId:
                  asString(body?.organizationId) ??
                  asString(returned?.organizationId) ??
                  undefined,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }),
        },
        {
          matcher: (context) => context.path === SIGN_IN_PATH,
          handler: createAuthMiddleware(async (ctx) => mapSignInSsoPluginError(ctx)),
        },
        {
          matcher: (context) => context.path === UPDATE_PATH,
          handler: createAuthMiddleware(async (ctx) =>
            mapUpdateProviderIdentityLock(ctx),
          ),
        },
      ],
    },
  };
}
