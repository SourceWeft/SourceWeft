import { APIError } from "better-auth/api";
import { billingOrganizationHooks } from "../../billing-host/bindings";
import { logger } from "../../shared/logger";
import { parseSourceweftOrganizationKind } from "../auth/organization-metadata";
import {
  recordSsoMemberRoleChangeAudit,
  recordSsoSignInAudit,
  type SsoAuditProtocol,
} from "./audit";
import {
  SSO_ERROR_CODES,
  SSO_ERROR_MESSAGES_EN,
  ssoErrorRedirect,
  type SsoErrorCode,
} from "./errors";

/**
 * JIT membership, account-linking rules and role mapping for enterprise SSO.
 *
 * Two halves, wired into the official `@better-auth/sso` plugin from
 * sso-plugin.ts:
 *
 *  - {@link resolveSsoSignIn} backs the plugin's `resolveUser` hook. It runs
 *    inside the sign-in transaction, BEFORE any user, account or session row is
 *    created, and decides whether the verified identity may sign in at all:
 *    it fails closed on a domain mismatch (an IdP asserting an email outside the
 *    provider's verified domain must never link to or create an account — plan
 *    Review Focus 1), and it pre-checks the billing seat so a rejection leaves
 *    no session behind (plan Review Focus 2). `@better-auth/sso@1.7.7` calls
 *    `provisionUser` AFTER the session is created and committed, so the seat
 *    check cannot live there without orphaning a session.
 *
 *  - {@link provisionSsoUser} backs `provisionUser`. By then the user exists and
 *    is signed in; this adds them to the provider's organization through the
 *    real member-added path (so billing, workspace access and audit all apply),
 *    syncs an existing member's role when the provider manages roles, and
 *    records the `sso.sign_in` audit entry.
 */

export type SsoSignInProtocol = SsoAuditProtocol;

/** The resolver decision shape `@better-auth/sso` validates and acts on. */
export type SsoUserResolution =
  | { action: "continue" }
  | { action: "link"; userId: string; profile: "preserve" }
  | { action: "reject"; code: string; message: string };

/** The read-only transaction adapter slice the resolver needs. */
export type SsoResolutionAdapter = {
  findOne: (args: {
    model: string;
    where: Array<{ field: string; value: unknown }>;
    select?: string[];
  }) => Promise<Record<string, unknown> | null>;
};

/**
 * Builds a resolver rejection whose `message` comes from
 * {@link SSO_ERROR_MESSAGES_EN} — the single English-language source of
 * truth every `SSO_ERROR_CODES` throw site uses (errors.ts) — rather than a
 * second, independent copy of the text. This message is never shown to a
 * user directly: the plugin redirects to the error URL carrying only the
 * `code` query param (a later task renders it); it still must not drift from
 * the table so logs/diagnostics stay consistent with the JSON-error paths.
 */
function reject(code: SsoErrorCode): SsoUserResolution {
  return { action: "reject", code, message: SSO_ERROR_MESSAGES_EN[code] };
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Whether an asserted email's domain is covered by the provider's verified
 * domain: an exact match, or a subdomain of it. Mirrors the plugin's own
 * `domainMatches` suffix rule (a provider verified for `acme.com` is trusted for
 * `x@mail.acme.com`), so our account-link gate and the plugin's trusted-provider
 * linking agree. An email without a domain part never matches.
 */
export function emailDomainMatchesProviderDomain(
  email: string,
  providerDomain: string,
): boolean {
  const emailDomain = email.split("@")[1]?.toLowerCase();
  const domain = providerDomain.toLowerCase();
  if (!emailDomain || !domain) {
    return false;
  }
  return emailDomain === domain || emailDomain.endsWith(`.${domain}`);
}

/**
 * Decide whether a verified SSO identity may sign in, and to which user.
 *
 * Runs inside the sign-in transaction. Rejecting here rolls back the whole
 * sign-in: no user, account or session row survives, and the plugin redirects
 * to the error URL carrying the rejection `code`.
 */
export async function resolveSsoSignIn(input: {
  providerId: string;
  email: string;
  database: SsoResolutionAdapter;
}): Promise<SsoUserResolution> {
  const { providerId, database } = input;
  const email = input.email.toLowerCase();

  const provider = await database.findOne({
    model: "ssoProvider",
    where: [{ field: "providerId", value: providerId }],
    select: ["providerId", "organizationId", "domain", "domainVerified"],
  });
  if (!provider) {
    return reject(SSO_ERROR_CODES.providerNotFound);
  }

  const organizationId = asNonEmptyString(provider.organizationId);
  const domain = asNonEmptyString(provider.domain);
  if (!organizationId || !domain) {
    return reject(SSO_ERROR_CODES.organizationRequired);
  }
  if (provider.domainVerified !== true) {
    return reject(SSO_ERROR_CODES.domainNotVerified);
  }

  // The provider's organization must still exist and still be a team org; a
  // deleted or demoted org can never gain SSO members.
  const organization = await database.findOne({
    model: "organization",
    where: [{ field: "id", value: organizationId }],
    select: ["id", "metadata"],
  });
  if (
    !organization ||
    parseSourceweftOrganizationKind(organization.metadata) !== "team"
  ) {
    return reject(SSO_ERROR_CODES.organizationRequired);
  }

  // Fail closed on a domain mismatch: an identity whose email domain is not
  // covered by the verified domain must never link to an existing account nor
  // create one. This also rejects an email with no domain part.
  if (!emailDomainMatchesProviderDomain(email, domain)) {
    return reject(SSO_ERROR_CODES.accountLinkDenied);
  }

  const existingUser = await database.findOne({
    model: "user",
    where: [{ field: "email", value: email }],
    select: ["id"],
  });
  const existingUserId = existingUser ? asNonEmptyString(existingUser.id) : null;

  let alreadyMember = false;
  if (existingUserId) {
    const member = await database.findOne({
      model: "member",
      where: [
        { field: "organizationId", value: organizationId },
        { field: "userId", value: existingUserId },
      ],
      select: ["id"],
    });
    alreadyMember = member !== null;
  }

  // Pre-check the billing seat before a session exists. Any rejection from the
  // member-added billing hook means no seat, so fail the whole sign-in with a
  // seat-limit code rather than orphan a session. Skipped for an existing
  // member, who consumes no new seat.
  if (!alreadyMember) {
    try {
      await billingOrganizationHooks.beforeAddMember(organizationId);
    } catch {
      return reject(SSO_ERROR_CODES.seatLimit);
    }
  }

  if (existingUserId) {
    return { action: "link", userId: existingUserId, profile: "preserve" };
  }
  return { action: "continue" };
}

/**
 * `@better-auth/sso@1.7.7` calls `provisionUser` without the plugin's own
 * `isRegister`, so whether this sign-in created a new user account is carried
 * from {@link resolveSsoSignIn}'s decision (continue = new, link = existing) to
 * {@link provisionSsoUser} through this per-identity map. An entry is set only
 * for a non-rejected resolution (one that will reach `provisionUser`) and is
 * read-and-deleted on provisioning, so the only possible residue is a rare
 * post-resolution authentication failure, which a retry of the same identity
 * overwrites.
 */
const newUserByIdentity = new Map<string, boolean>();

function identityKey(providerId: string, accountId: string): string {
  return `${providerId}\u0000${accountId}`;
}

export function rememberSsoIsNewUser(
  providerId: string,
  accountId: string,
  isNewUser: boolean,
): void {
  newUserByIdentity.set(identityKey(providerId, accountId), isNewUser);
}

export function takeSsoIsNewUser(
  providerId: string,
  accountId: string,
): boolean {
  const key = identityKey(providerId, accountId);
  const value = newUserByIdentity.get(key);
  newUserByIdentity.delete(key);
  return value ?? false;
}

/** The auth-context slice {@link provisionSsoUser} needs. */
type SsoProvisioningContext = {
  adapter: {
    findOne: (args: {
      model: string;
      where: Array<{ field: string; value: unknown }>;
      select?: string[];
    }) => Promise<Record<string, unknown> | null>;
    findMany: (args: {
      model: string;
      where: Array<{ field: string; value: unknown }>;
      select?: string[];
    }) => Promise<Array<Record<string, unknown>>>;
    update: (args: {
      model: string;
      where: Array<{ field: string; value: unknown }>;
      update: Record<string, unknown>;
    }) => Promise<unknown>;
    delete: (args: {
      model: string;
      where: Array<{ field: string; value: unknown }>;
    }) => Promise<unknown>;
  };
};

function toMillis(value: unknown): number {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === "string" || typeof value === "number") {
    const time = new Date(value).getTime();
    return Number.isNaN(time) ? 0 : time;
  }
  return 0;
}

/**
 * Undo a sign-in whose membership step failed after the session was committed.
 *
 * `@better-auth/sso@1.7.7` creates and commits the session before it calls
 * `provisionUser`, so a membership failure there leaves a committed session row
 * (and, for a brand-new identity, a committed user + SSO account). The session
 * cookie is never set, because the plugin sets it only after `provisionUser`
 * returns, so this only has to remove the committed rows:
 *
 *  - the session this sign-in created — identified as the most recent session
 *    for the user, which is this one (provisionUser runs synchronously, within
 *    the same request, immediately after the session is committed);
 *  - any membership row (defensive: the member-added path throws its billing
 *    seat check before it inserts a row, but a later failure could leave one);
 *  - the SSO account this provider linked (matched by provider + user);
 *  - and, only for a user this sign-in created, the user row itself.
 *
 * An existing user's own rows (their password/other accounts and their other
 * sessions) are left untouched.
 */
async function rollbackFailedSsoSignIn(
  context: SsoProvisioningContext,
  input: {
    userId: string;
    organizationId: string;
    providerId: string;
    isNewUser: boolean;
  },
): Promise<void> {
  const sessions = await context.adapter.findMany({
    model: "session",
    where: [{ field: "userId", value: input.userId }],
    select: ["id", "createdAt"],
  });
  const newest = sessions.reduce<Record<string, unknown> | null>(
    (latest, session) =>
      latest === null || toMillis(session.createdAt) >= toMillis(latest.createdAt)
        ? session
        : latest,
    null,
  );
  if (newest?.id) {
    await context.adapter.delete({
      model: "session",
      where: [{ field: "id", value: String(newest.id) }],
    });
  }

  await context.adapter.delete({
    model: "member",
    where: [
      { field: "organizationId", value: input.organizationId },
      { field: "userId", value: input.userId },
    ],
  });

  await context.adapter.delete({
    model: "account",
    where: [
      { field: "providerId", value: input.providerId },
      { field: "userId", value: input.userId },
    ],
  });

  if (input.isNewUser) {
    await context.adapter.delete({
      model: "user",
      where: [{ field: "id", value: input.userId }],
    });
  }
}

/**
 * Add or reconcile a signed-in SSO user's membership of the provider's
 * organization, then audit the sign-in.
 *
 * Rules:
 *  1. Already a member whose role contains `owner`: untouched. Otherwise, when
 *     the provider manages roles (`roleManaged`) and the mapped role differs,
 *     the role is updated and an `organization.member_role_changed` entry is
 *     recorded. No workspace rewrite is needed — the workspace role derives from
 *     the organization role on every read (see auth-config.ts, which records no
 *     `afterUpdateMemberRole` for the same reason).
 *  2. Not a member: added via `auth.api.addMember`, the same member-added path
 *     an admin invitation uses, so the billing seat hook, workspace provisioning
 *     and `organization.member_added` audit all run.
 *  3. Every SSO sign-in is recorded as `sso.sign_in`.
 *
 * `role` is already mapped (never `owner`). A brand-new account is already
 * `emailVerified: true` before this runs — the guard's `user.create` hook marks
 * an SSO-created account verified (ownership is proven by the verified domain +
 * matching email, which `resolveUser` enforced), so no redundant verification
 * mail is sent and `trustEmailVerified` stays unset.
 *
 * The member-added step runs after the plugin has already committed the session.
 * If it throws (a seat taken since the resolver's pre-check, a billing error, a
 * vanished organization), the committed session — and a brand-new user + its SSO
 * account — are rolled back by {@link rollbackFailedSsoSignIn} and a redirect to
 * the error URL carrying {@link SSO_ERROR_CODES.seatLimit} or
 * {@link SSO_ERROR_CODES.provisioningFailed} is thrown. Throwing the redirect
 * from here (inside the plugin's callback endpoint, via a `FOUND` `APIError`)
 * routes it through the same error-URL response the plugin emits for a resolver
 * rejection, rather than surfacing a raw error body. Audit recording and the
 * role-sync write are best-effort: once membership exists the sign-in has
 * succeeded, so their failures are logged, not raised.
 */
export async function provisionSsoUser(input: {
  userId: string;
  organizationId: string;
  role: "member" | "admin";
  providerId: string;
  protocol: SsoSignInProtocol;
  domain: string;
  isNewUser: boolean;
  roleManaged: boolean;
}): Promise<void> {
  // Lazy import breaks the module-load cycle with auth-config (which registers
  // this plugin). Both this and the handling auth instance share one DB.
  const { auth } = await import("../auth/auth");
  const context = (await auth.$context) as unknown as SsoProvisioningContext;

  const member = await context.adapter.findOne({
    model: "member",
    where: [
      { field: "organizationId", value: input.organizationId },
      { field: "userId", value: input.userId },
    ],
    select: ["id", "role"],
  });

  if (!member) {
    try {
      await auth.api.addMember({
        body: {
          userId: input.userId,
          organizationId: input.organizationId,
          role: input.role,
        },
      });
    } catch (error) {
      await rollbackFailedSsoSignIn(context, input);
      throw provisioningRedirect(
        await isSeatRejection(input.organizationId),
        error,
      );
    }
  } else if (input.roleManaged) {
    // Role sync is best-effort; a failure must not undo a sign-in whose
    // membership already holds.
    try {
      await syncExistingMemberRole({
        context,
        memberId: String(member.id),
        currentRole: typeof member.role === "string" ? member.role : "",
        nextRole: input.role,
        organizationId: input.organizationId,
        userId: input.userId,
      });
    } catch (error) {
      logger.error("sso_role_sync_failed", {
        organizationId: input.organizationId,
        userId: input.userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Best-effort: the sign-in has succeeded by now.
  try {
    await recordSsoSignInAudit({
      teamId: input.organizationId,
      actorUserId: input.userId,
      providerId: input.providerId,
      protocol: input.protocol,
      domain: input.domain,
      isNewUser: input.isNewUser,
    });
  } catch (error) {
    logger.error("sso_sign_in_audit_failed", {
      organizationId: input.organizationId,
      userId: input.userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Promote/demote a non-owner member to the mapped role, auditing the change. */
async function syncExistingMemberRole(input: {
  context: SsoProvisioningContext;
  memberId: string;
  currentRole: string;
  nextRole: "member" | "admin";
  organizationId: string;
  userId: string;
}): Promise<void> {
  const isOwner = input.currentRole
    .split(",")
    .map((entry) => entry.trim())
    .includes("owner");
  if (isOwner || input.currentRole === input.nextRole) {
    return;
  }
  await input.context.adapter.update({
    model: "member",
    where: [{ field: "id", value: input.memberId }],
    update: { role: input.nextRole },
  });
  await recordSsoMemberRoleChangeAudit({
    teamId: input.organizationId,
    userId: input.userId,
    previousRole: input.currentRole,
    newRole: input.nextRole,
  });
}

/**
 * Whether the organization's billing seat check now rejects, used to classify a
 * failed member-add after the fact: a seat rejection becomes `SSO_SEAT_LIMIT`,
 * anything else `SSO_PROVISIONING_FAILED`. Re-running the (read-only) seat hook
 * is the only reliable discriminator, since `addMember` can throw for either.
 */
async function isSeatRejection(organizationId: string): Promise<boolean> {
  try {
    await billingOrganizationHooks.beforeAddMember(organizationId);
    return false;
  } catch {
    return true;
  }
}

/**
 * Build the error-URL redirect for a failed membership step, delegating to the
 * shared {@link ssoErrorRedirect} (the same 302-to-error-page construction the
 * guard's SAML algorithm policy reuses). A membership failure after the session
 * is committed redirects to the error page carrying `SSO_SEAT_LIMIT` or
 * `SSO_PROVISIONING_FAILED`, never a raw error body; no session cookie is set,
 * because the plugin sets it only after `provisionUser` returns.
 */
function provisioningRedirect(isSeat: boolean, cause: unknown): APIError {
  return ssoErrorRedirect(
    isSeat ? SSO_ERROR_CODES.seatLimit : SSO_ERROR_CODES.provisioningFailed,
    cause,
  );
}
