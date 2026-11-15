import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { authErrorTranslations, resolveGuardErrorLocale } from "../auth/auth-error-i18n";
import {
  recordSsoProviderChangeAfterHook,
  SSO_AUDIT_PATHS,
  snapshotSsoProviderForAudit,
} from "./audit";
import { SSO_ERROR_CODES, ssoError } from "./errors";
import {
  assertSsoDomainAllowed,
  assertTeamOrganization,
  normalizeSsoDomain,
  ssoDomainCandidates,
  type SsoProviderDomainLookup,
  type SsoProviderDomainRow,
} from "./policy";
import { validateRoleAttribute } from "./role-mapping";

/**
 * Tenant-policy guard for `@better-auth/sso` provider registration, updates,
 * domain verification and email-based sign-in routing.
 *
 * The official plugin already rejects non-members (400) and non-admins (403),
 * hides other organizations' providers, and SSRF-checks OIDC endpoints. This
 * guard adds the SourceWeft multi-tenant rules the plugin cannot know:
 *
 *  - register/update: a provider must belong to a `team` organization; its
 *    domain is normalized, must be private (no public mailbox provider), must be
 *    unique within its organization, and must not be verified by another
 *    organization (an unverified claim by another org does not block — ownership
 *    is established by verification). A team is capped at
 *    {@link MAX_PROVIDERS_PER_ORGANIZATION} providers, and a SAML provider always
 *    stores `wantAssertionsSigned: true`.
 *  - verify-domain: a domain already verified by another organization cannot be
 *    verified again. A partial unique index backstops the check against races;
 *    its violation is mapped to a clean `SSO_DOMAIN_NOT_ALLOWED` (see
 *    {@link VERIFIED_DOMAIN_UNIQUE_INDEX}).
 *  - sign-in: email/domain sign-in is routed to the exact verified provider,
 *    else the nearest verified parent domain, making unverified squatter rows
 *    invisible. No verified match is a 404 `SSO_PROVIDER_NOT_FOUND`.
 *
 * Rejections throw a better-auth `APIError` whose JSON body `code` is the
 * matching {@link SSO_ERROR_CODES} value.
 */

const REGISTER_PATH = "/sso/register";
const UPDATE_PATH = "/sso/update-provider";
const DELETE_PATH = "/sso/delete-provider";
const VERIFY_DOMAIN_PATH = "/sso/verify-domain";
const SIGN_IN_PATH = "/sign-in/sso";
const SSO_PROVIDER_MODEL = "ssoProvider";

/**
 * The SSO sign-in callback / SAML ACS routes. Membership provisioning runs after
 * these commit a session, and a provisioning failure (see ./provisioning.ts) is
 * turned into an error-URL redirect by the after-hook below; a user created on
 * these paths is also marked email-verified (its domain was proven by the
 * resolver). Matched by the endpoint's route pattern, as the other hooks are.
 */
const SSO_CALLBACK_PATHS = new Set([
  "/sso/callback",
  "/sso/callback/:providerId",
  "/sso/saml2/sp/acs/:providerId",
]);

function isSsoCallbackPath(path: unknown): boolean {
  return typeof path === "string" && SSO_CALLBACK_PATHS.has(path);
}

/** Reserved OIDC/SAML mapping keys reused as role claims, for the SAML name default. */
const SAML_NAME_MAPPING_DEFAULT = "displayName";
const OIDC_NAME_MAPPING_DEFAULT = "name";
const EMAIL_MAPPING_DEFAULT = "email";

/**
 * Maximum SSO providers one organization may own. The plugin's `providersLimit`
 * caps providers per registering user; this caps them per tenant.
 */
export const MAX_PROVIDERS_PER_ORGANIZATION = 5;

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
 * existing mapping untouched). A present-but-invalid attribute (reserved key or
 * over-long) is rejected with {@link SSO_ERROR_CODES.invalidRoleAttribute}.
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
 * Carry the role claim into a config's `mapping.extraFields`, so the attribute
 * the IdP returns under `roleAttribute` reaches `userInfo` and role mapping can
 * read it. Existing mapping is preserved; `email`/`name` are defaulted so the
 * (strict) mapping schema still validates after this before-hook.
 */
function withRoleExtraField(
  providerConfig: Record<string, unknown>,
  roleAttribute: string,
  kind: "oidc" | "saml",
): Record<string, unknown> {
  const existing = asMapping(providerConfig.mapping);
  const extraFields = {
    ...asMapping(existing.extraFields),
    [roleAttribute]: roleAttribute,
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

async function handleRegister(
  ctx: { body?: Record<string, unknown> },
  adapter: GuardAdapter,
) {
  const body = ctx.body as Record<string, unknown>;
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

  return {
    context: {
      body: withSignedAssertions(applyRegisterRoleMapping({ ...body, domain })),
    },
  };
}

async function handleUpdate(
  ctx: { body?: Record<string, unknown> },
  adapter: GuardAdapter,
) {
  const body = ctx.body as Record<string, unknown>;
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

  // Keep the role claim in the mapping when the attribute is (re)set. The update
  // body may carry only the attribute, so merge into the body's config when it
  // sends one, else into a mapping-only patch over the provider's current config
  // (the plugin's mergeOIDCConfig/mergeSAMLConfig preserves the rest).
  const roleAttribute = roleAttributeFromBody(body);
  if (roleAttribute && providerId) {
    const current = await adapter.findOne({
      model: SSO_PROVIDER_MODEL,
      where: [{ field: "providerId", value: providerId }],
      // organizationId is required so the secret-storage adapter wrapper can
      // resolve the team key when it decrypts the stored config on read.
      select: ["organizationId", "oidcConfig", "samlConfig"],
    });
    if (body.oidcConfig && typeof body.oidcConfig === "object") {
      nextBody.oidcConfig = withRoleExtraField(
        body.oidcConfig as Record<string, unknown>,
        roleAttribute,
        "oidc",
      );
    } else if (body.samlConfig && typeof body.samlConfig === "object") {
      nextBody.samlConfig = withRoleExtraField(
        body.samlConfig as Record<string, unknown>,
        roleAttribute,
        "saml",
      );
    } else if (current?.oidcConfig) {
      nextBody.oidcConfig = withRoleExtraField(
        { mapping: storedConfigMapping(current.oidcConfig) },
        roleAttribute,
        "oidc",
      );
    } else if (current?.samlConfig) {
      nextBody.samlConfig = withRoleExtraField(
        { mapping: storedConfigMapping(current.samlConfig) },
        roleAttribute,
        "saml",
      );
    }
  }

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
  // Only resolve when the caller did not name a provider or organization.
  if (asString(body.providerId) || asString(body.organizationSlug)) {
    return;
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
            await recordSsoProviderChangeAfterHook(ctx);
          }),
        },
        {
          matcher: (context) => context.path === SIGN_IN_PATH,
          handler: createAuthMiddleware(async (ctx) => mapSignInSsoPluginError(ctx)),
        },
      ],
    },
  };
}
