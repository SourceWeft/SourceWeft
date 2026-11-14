import { APIError } from "better-auth/api";
import type { TeamAuditAction, TeamAuditEntry } from "../team-audit/types";

/**
 * Records `/sso/register`, `/sso/update-provider`, `/sso/delete-provider` and
 * `/sso/verify-domain` as team audit log entries.
 *
 * All the metadata recorded is `{ providerId, protocol, domain }` — never a
 * configuration value, certificate, claim or attribute value. `protocol` is
 * derived from the presence of a `samlConfig`, never read for its contents.
 */

const REGISTER_PATH = "/sso/register";
const UPDATE_PATH = "/sso/update-provider";
const DELETE_PATH = "/sso/delete-provider";
const VERIFY_DOMAIN_PATH = "/sso/verify-domain";

const ACTION_BY_PATH: Partial<Record<string, TeamAuditAction>> = {
  [REGISTER_PATH]: "sso.provider_created",
  [UPDATE_PATH]: "sso.provider_updated",
  [DELETE_PATH]: "sso.provider_deleted",
  [VERIFY_DOMAIN_PATH]: "sso.domain_verified",
};

export const SSO_AUDIT_PATHS = [
  REGISTER_PATH,
  UPDATE_PATH,
  DELETE_PATH,
  VERIFY_DOMAIN_PATH,
] as const;

export type SsoAuditProtocol = "oidc" | "saml";

/**
 * The minimal shape this module reads from a provider row or endpoint
 * response. The real object (a plugin response or a raw DB row) usually
 * carries far more — `oidcConfig.clientSecret`, `samlConfig.cert`, claim
 * mappings — none of which this type names, and none of which the builder
 * below ever touches.
 */
export type SsoAuditProviderLike = {
  providerId: string;
  domain: string;
  samlConfig?: unknown;
};

/**
 * Build the audit-log entry for a provider lifecycle event. Only
 * `providerId`, `domain`, and whether `samlConfig` is present (for
 * `protocol`) are read off `input.provider`; every other field — including
 * any secret it carries — is ignored.
 */
export function buildSsoProviderAuditEntry(input: {
  action: TeamAuditAction;
  teamId: string;
  actorUserId: string | null;
  provider: SsoAuditProviderLike;
}): TeamAuditEntry {
  const protocol: SsoAuditProtocol = input.provider.samlConfig ? "saml" : "oidc";
  return {
    teamId: input.teamId,
    actorUserId: input.actorUserId,
    action: input.action,
    targetType: "sso_provider",
    targetId: input.provider.providerId,
    metadata: {
      providerId: input.provider.providerId,
      protocol,
      domain: input.provider.domain,
    },
  };
}

/** Record the entry via the team-audit service. Lazily imported, as
 * auth-config.ts does for the same module, to avoid a module-load cycle
 * between the auth plugins and team-audit. */
export async function recordSsoProviderAudit(
  entry: TeamAuditEntry,
): Promise<void> {
  const { teamAuditService } = await import("../team-audit");
  await teamAuditService.record(entry);
}

/** The narrow adapter slice needed to snapshot a provider row. */
type SnapshotAdapter = {
  findOne: (args: {
    model: string;
    where: Array<{ field: string; value: unknown }>;
    select?: string[];
  }) => Promise<Record<string, unknown> | null>;
};

type SsoProviderSnapshot = {
  organizationId: string | null;
  providerId: string;
  domain: string;
  samlConfig: unknown;
};

/**
 * `/sso/delete-provider`'s row is gone by the time the after-hook runs, and
 * `/sso/verify-domain`'s response carries no body at all (a bare 204). Both
 * need their provider snapshotted by a before-hook, ahead of the mutation.
 *
 * The snapshot is stashed on a `WeakMap` keyed by `ctx.context` — the one
 * object better-auth's dispatcher threads unchanged from its before-hooks,
 * through the endpoint handler, to its after-hooks (confirmed against
 * better-auth@1.7.7's `dispatchAuthEndpoint`/`runAfterHooks` in
 * `api/dispatch.mjs`: the after-hook handler receives that same `context`
 * object, not a copy, and mutations made to it earlier in the request are
 * visible there). A `WeakMap` avoids grafting an ad hoc field onto that
 * shared, strongly-typed object, and lets the entry be collected once the
 * request's own context is — no explicit cleanup needed beyond the
 * `delete` in {@link takeSsoProviderSnapshot}, which only guards against a
 * (currently impossible) same-path hook running twice.
 */
const providerSnapshots = new WeakMap<object, SsoProviderSnapshot>();

const SSO_PROVIDER_MODEL = "ssoProvider";

/** Before-hook body for `/sso/delete-provider` and `/sso/verify-domain`:
 * snapshot the row's team/domain/protocol ahead of the mutation that makes
 * them unrecoverable from the response. A missing row is left unsnapshotted;
 * the endpoint will itself 404, and the after-hook has nothing to record. */
export async function snapshotSsoProviderForAudit(
  ctx: { context: object },
  adapter: SnapshotAdapter,
  providerId: string,
): Promise<void> {
  const row = await adapter.findOne({
    model: SSO_PROVIDER_MODEL,
    where: [{ field: "providerId", value: providerId }],
    select: ["providerId", "organizationId", "domain", "samlConfig"],
  });
  if (!row) {
    return;
  }
  providerSnapshots.set(ctx.context, {
    organizationId:
      typeof row.organizationId === "string" ? row.organizationId : null,
    providerId: String(row.providerId ?? providerId),
    domain: String(row.domain ?? ""),
    samlConfig: row.samlConfig,
  });
}

/** Read and clear this request's snapshot, if one was taken. */
function takeSsoProviderSnapshot(ctx: {
  context: object;
}): SsoProviderSnapshot | null {
  const snapshot = providerSnapshots.get(ctx.context);
  if (snapshot) {
    providerSnapshots.delete(ctx.context);
  }
  return snapshot ?? null;
}

type AfterHookCtx = {
  path?: string;
  context: {
    returned?: unknown;
    session?: { user?: { id?: string } } | null;
  };
};

/** The shape of a successful register/update-provider response this module
 * reads `providerId`, `domain`, `organizationId` and `samlConfig` off. */
type SsoEndpointResponse = {
  providerId?: unknown;
  domain?: unknown;
  organizationId?: unknown;
  samlConfig?: unknown;
};

function isSsoEndpointResponse(value: unknown): value is SsoEndpointResponse {
  return typeof value === "object" && value !== null;
}

/**
 * The single `hooks.after` handler for `/sso/register`, `/sso/update-provider`,
 * `/sso/delete-provider` and `/sso/verify-domain`. Records a team audit log
 * entry only when the endpoint actually succeeded:
 *
 *  - register/update-provider: the provider (`providerId`, `domain`,
 *    `organizationId`, `samlConfig`) comes straight off the endpoint's own
 *    response.
 *  - delete-provider/verify-domain: it comes off the before-hook snapshot
 *    (see {@link snapshotSsoProviderForAudit}), since the response carries
 *    none of it.
 *
 * A better-auth after-hook sees a failed call as `ctx.context.returned`
 * being an `APIError` instance (confirmed against better-auth@1.7.7's
 * `dispatchAuthEndpoint`, which catches the endpoint's thrown `APIError` and
 * assigns it to `context.returned` before running after-hooks) — that case,
 * and the case where no team/provider could be resolved at all (e.g. an
 * organization-less provider, which the guard already keeps immutable),
 * both record nothing.
 */
export async function recordSsoProviderChangeAfterHook(
  ctx: AfterHookCtx,
): Promise<void> {
  const path = ctx.path;
  const action = path ? ACTION_BY_PATH[path] : undefined;
  if (!action) {
    return;
  }
  if (ctx.context.returned instanceof APIError) {
    return;
  }

  const actorUserId = ctx.context.session?.user?.id ?? null;

  let teamId: string | null = null;
  let provider: SsoAuditProviderLike | null = null;

  if (path === REGISTER_PATH || path === UPDATE_PATH) {
    const returned = ctx.context.returned;
    if (
      isSsoEndpointResponse(returned) &&
      typeof returned.providerId === "string" &&
      typeof returned.domain === "string"
    ) {
      teamId =
        typeof returned.organizationId === "string"
          ? returned.organizationId
          : null;
      provider = {
        providerId: returned.providerId,
        domain: returned.domain,
        samlConfig: returned.samlConfig,
      };
    }
  } else {
    const snapshot = takeSsoProviderSnapshot(ctx);
    if (snapshot) {
      teamId = snapshot.organizationId;
      provider = {
        providerId: snapshot.providerId,
        domain: snapshot.domain,
        samlConfig: snapshot.samlConfig,
      };
    }
  }

  if (!teamId || !provider) {
    return;
  }

  await recordSsoProviderAudit(
    buildSsoProviderAuditEntry({ action, teamId, actorUserId, provider }),
  );
}
