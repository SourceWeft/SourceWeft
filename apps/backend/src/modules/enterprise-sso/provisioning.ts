import { APIError } from "better-auth/api";
import { isBillingError } from "@sourceweft/contracts/billing-runtime";
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
import { takeSsoSignInCapture } from "./sso-sign-in-capture";

/**
 * JIT membership, account-linking rules and role mapping for enterprise SSO.
 *
 * Two halves, wired into the official `@better-auth/sso` plugin from
 * sso-plugin.ts:
 *
 *  - {@link resolveSsoSignIn} backs the plugin's `resolveUser` hook. It runs
 *    inside the sign-in transaction, BEFORE any user, account or session row is
 *    created, and decides whether the verified identity may sign in at all. It
 *    fails closed on a domain mismatch (an IdP asserting an email outside the
 *    provider's verified domain), and — the C1 fix — never links to a
 *    pre-existing UNVERIFIED local account. Every query it makes runs on the
 *    transaction's own database handle; it acquires no second pooled connection,
 *    so it cannot deadlock the shared pool while it holds the provider row lock.
 *
 *  - {@link provisionSsoUser} backs `provisionUser`, which the plugin calls AFTER
 *    the session is created and the transaction has committed. It adds the user
 *    to the provider's organization through the real member-added path (so
 *    billing, workspace access and audit all apply), reconciles a managed role,
 *    and records the `sso.sign_in` audit entry. If the membership step fails it
 *    is NON-DESTRUCTIVE: it revokes only the session this sign-in created and
 *    redirects to the error page, leaving the user, SSO account and personal
 *    workspace in place so the next sign-in retries membership.
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
 * `code` query param; it still must not drift from the table so
 * logs/diagnostics stay consistent with the JSON-error paths.
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
 * linking agree.
 *
 * The domain is the part after the LAST `@` (as the guard's routing uses), and an
 * address with anything other than exactly one `@` never matches — so a crafted
 * `victim@acme.com@evil.com` (whose real mailbox is at `evil.com`) is rejected
 * rather than treated as `evil.com` while matching nothing, or as `acme.com`.
 */
export function emailDomainMatchesProviderDomain(
  email: string,
  providerDomain: string,
): boolean {
  const atCount = email.split("@").length - 1;
  if (atCount !== 1) {
    return false;
  }
  const emailDomain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
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
 *
 * Every read goes through `database` — the transaction adapter the plugin hands
 * the resolver — so nothing here acquires a second pooled connection while the
 * transaction holds its connection and the provider row lock (the I1 deadlock).
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
    select: ["id", "emailVerified"],
  });
  const existingUserId = existingUser ? asNonEmptyString(existingUser.id) : null;

  // Fail closed on a pre-existing UNVERIFIED local account (C1). Returning
  // `link` makes the plugin skip its own `requireLocalEmailVerified` refusal (it
  // only applies when no `selectedUser` is supplied — better-auth
  // dist/oauth2/link-account.mjs), so a link here would attach the SSO identity
  // to a row nobody has proven they own — the pre-hijack takeover. A verified
  // row links as before; an unverified one is rejected and left untouched.
  //
  // Returning `continue` is safe: it is reached only when NO user has this
  // email, and if a row somehow appeared the plugin's own unverified-link
  // refusal still applies (no `selectedUser` is handed over for a `continue`).
  if (existingUserId) {
    if (existingUser?.emailVerified !== true) {
      return reject(SSO_ERROR_CODES.accountLinkDenied);
    }
    return { action: "link", userId: existingUserId, profile: "preserve" };
  }
  return { action: "continue" };
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

/** better-auth's error code when a member row already exists for the user. */
const ALREADY_A_MEMBER_CODE = "USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION";

/**
 * The commercial billing seat-limit signal. The seat check throws a
 * `BillingError("TEAM_SEAT_LIMIT_REACHED", …)` (enterprise/billing's
 * subscription-service); the add-member org hook raises it inside
 * `auth.api.addMember`, which re-throws non-`APIError`s unchanged, so it reaches
 * us here. Any OTHER failure is reported as a generic provisioning failure, not
 * as "no seats left".
 */
const SEAT_LIMIT_BILLING_CODE = "TEAM_SEAT_LIMIT_REACHED";

/** Only the seat-limit case maps to `SSO_SEAT_LIMIT`; everything else is generic. */
function isSeatLimitError(error: unknown): boolean {
  for (let layer: unknown = error, depth = 0; layer && depth < 5; depth += 1) {
    if (isBillingError(layer) && layer.code === SEAT_LIMIT_BILLING_CODE) {
      return true;
    }
    layer = (layer as { cause?: unknown }).cause;
  }
  return false;
}

/** Whether `auth.api.addMember` failed because the user is already a member. */
function isAlreadyMemberError(error: unknown): boolean {
  return (
    error instanceof APIError &&
    (error.body as { code?: unknown } | undefined)?.code === ALREADY_A_MEMBER_CODE
  );
}

/**
 * Revoke ONLY the session this sign-in created, after a membership step failed.
 *
 * `@better-auth/sso@1.7.7` creates and commits the session before it calls
 * `provisionUser`, but sets the session cookie only after `provisionUser`
 * returns — so a failure here leaves a committed, cookie-less session row that
 * must be removed, and nothing else. The session is identified EXACTLY from the
 * `session.create.after` capture (keyed by this request's endpoint context); if
 * no capture is present there is no safe session to revoke, so nothing is
 * deleted and the gap is logged — never a heuristic that could revoke another
 * sign-in's session.
 *
 * Nothing else is deleted: a brand-new identity keeps its user row (email
 * verified, SSO account linked, personal workspace) without team membership, and
 * the next SSO sign-in retries the membership step.
 */
async function revokeSsoSignInSession(
  context: SsoProvisioningContext,
  input: { userId: string; organizationId: string; providerId: string },
  sessionId: string | undefined,
): Promise<void> {
  if (!sessionId) {
    logger.error("sso_session_revocation_skipped", {
      organizationId: input.organizationId,
      providerId: input.providerId,
      reason: "no_session_capture",
    });
    return;
  }
  try {
    await context.adapter.delete({
      model: "session",
      where: [{ field: "id", value: sessionId }],
    });
  } catch (error) {
    logger.error("sso_session_revocation_failed", {
      organizationId: input.organizationId,
      providerId: input.providerId,
      reason: "membership_failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Per-`(organizationId, userId)` in-process mutex serializing the membership
 * step. `provisionUser` runs AFTER the sign-in transaction commits, so holding
 * this across its awaits cannot deadlock the pool, and it makes "check → add →
 * re-read" atomic within this process: two concurrent sign-ins of one identity
 * no longer both pass the existence check and insert two member rows. Across
 * multiple API processes a database constraint would still be needed; the
 * post-add de-duplication below is the defensive backstop.
 */
const membershipLocks = new Map<string, Promise<unknown>>();

function membershipLockKey(organizationId: string, userId: string): string {
  return `${organizationId}\u0000${userId}`;
}

async function runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = membershipLocks.get(key) ?? Promise.resolve();
  let release: () => void = () => {};
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = prior.then(() => mine, () => mine);
  membershipLocks.set(key, tail);
  await prior.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (membershipLocks.get(key) === tail) {
      membershipLocks.delete(key);
    }
  }
}

type MemberRow = Record<string, unknown>;

/** Read this user's member row for the organization. */
async function findSsoMember(
  context: SsoProvisioningContext,
  input: { organizationId: string; userId: string },
): Promise<MemberRow | null> {
  return context.adapter.findOne({
    model: "member",
    where: [
      { field: "organizationId", value: input.organizationId },
      { field: "userId", value: input.userId },
    ],
    select: ["id", "role", "createdAt"],
  });
}

/**
 * Role precedence for choosing which duplicate member row to keep: a role
 * string containing `owner` outranks one containing `admin`, which outranks the
 * rest. Substring (case-insensitive) so a composite role like `owner,member`
 * still counts as owner — a superset of {@link syncExistingMemberRole}'s owner
 * check, so no row this treats as owner can ever be demoted or deleted.
 */
function memberRoleRank(role: unknown): 0 | 1 | 2 {
  const value = typeof role === "string" ? role.toLowerCase() : "";
  if (value.includes("owner")) return 2;
  if (value.includes("admin")) return 1;
  return 0;
}

/**
 * Re-read the member rows and collapse any duplicates — a check-then-insert race
 * (another API process, or an add that slipped past the mutex) can leave more
 * than one row for the same user in the organization. This runs on every
 * sign-in, so it must never drop a privileged row: the survivor is the HIGHEST
 * role (owner > admin > rest), then the oldest `createdAt`, then the smallest
 * `id` as a final deterministic tie-break. A row whose role contains `owner` is
 * never deleted. If two rows both contain `owner` — or the survivor cannot be
 * decided confidently — nothing is deleted and a warning is logged with the
 * member ids; the (oldest) owner row is still returned so role sync operates on
 * an owner and leaves it untouched. Returns the surviving row.
 */
async function reconcileSsoMemberRows(
  context: SsoProvisioningContext,
  input: { organizationId: string; userId: string },
): Promise<MemberRow | null> {
  const rows = await context.adapter.findMany({
    model: "member",
    where: [
      { field: "organizationId", value: input.organizationId },
      { field: "userId", value: input.userId },
    ],
    select: ["id", "role", "createdAt"],
  });
  if (rows.length <= 1) {
    return rows[0] ?? null;
  }

  const byId = (a: MemberRow, b: MemberRow) => {
    const left = String(a.id);
    const right = String(b.id);
    return left < right ? -1 : left > right ? 1 : 0;
  };

  const owners = rows.filter((row) => memberRoleRank(row.role) === 2);
  if (owners.length > 1) {
    // Two rows both claim owner: collapsing either could drop an owner. Leave
    // every row in place for a human and keep role sync on the oldest owner.
    logger.warn("sso_duplicate_member_rows_unresolved", {
      organizationId: input.organizationId,
      userId: input.userId,
      reason: "multiple_owner_rows",
      memberIds: rows.map((row) => String(row.id)),
    });
    return [...owners].sort(
      (a, b) => toMillis(a.createdAt) - toMillis(b.createdAt) || byId(a, b),
    )[0]!;
  }

  // Highest role first, then oldest, then smallest id — fully deterministic.
  const sorted = [...rows].sort(
    (a, b) =>
      memberRoleRank(b.role) - memberRoleRank(a.role) ||
      toMillis(a.createdAt) - toMillis(b.createdAt) ||
      byId(a, b),
  );
  const survivor = sorted[0]!;
  const duplicates = sorted.slice(1);
  logger.warn("sso_duplicate_member_rows", {
    organizationId: input.organizationId,
    userId: input.userId,
    keptMemberId: String(survivor.id),
    keptRole: typeof survivor.role === "string" ? survivor.role : null,
    deletedMemberIds: duplicates.map((row) => String(row.id)),
  });
  for (const row of duplicates) {
    if (memberRoleRank(row.role) === 2) {
      // Unreachable (a lone owner always outranks and survives), but never
      // delete an owner row even if the invariant above is violated.
      continue;
    }
    await context.adapter.delete({
      model: "member",
      where: [{ field: "id", value: String(row.id) }],
    });
  }
  return survivor;
}

/**
 * A failed membership step: log it, revoke this sign-in's session, and return
 * the error-URL redirect to throw. Any failure of the member reads/adds (not
 * just addMember) routes here, so none can surface as a raw 500.
 */
async function failedMembershipRedirect(
  context: SsoProvisioningContext,
  input: { organizationId: string; userId: string; providerId: string },
  sessionId: string | undefined,
  error: unknown,
): Promise<APIError> {
  const seat = isSeatLimitError(error);
  logger.error("sso_membership_add_failed", {
    organizationId: input.organizationId,
    providerId: input.providerId,
    reason: seat ? "seat_limit" : "provisioning_failed",
    error: error instanceof Error ? error.message : String(error),
  });
  await revokeSsoSignInSession(context, input, sessionId);
  return ssoErrorRedirect(
    seat ? SSO_ERROR_CODES.seatLimit : SSO_ERROR_CODES.provisioningFailed,
    error,
  );
}

/**
 * Ensure the signed-in user is a member of the organization, serialized per
 * `(organizationId, userId)`. Returns the (single, surviving) member row.
 * Throws the error-URL redirect on a genuine failure; an "already a member" from
 * a concurrent add is success.
 */
async function ensureSsoMembership(
  context: SsoProvisioningContext,
  auth: {
    api: {
      addMember: (args: {
        body: {
          userId: string;
          organizationId: string;
          role: "member" | "admin";
        };
      }) => Promise<unknown>;
    };
  },
  input: {
    userId: string;
    organizationId: string;
    role: "member" | "admin";
    providerId: string;
  },
  sessionId: string | undefined,
): Promise<MemberRow | null> {
  let member: MemberRow | null;
  try {
    member = await findSsoMember(context, input);
  } catch (error) {
    throw await failedMembershipRedirect(context, input, sessionId, error);
  }

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
      if (!isAlreadyMemberError(error)) {
        throw await failedMembershipRedirect(context, input, sessionId, error);
      }
      // A concurrent sign-in of this identity (or an invitation accept) won the
      // race: that is success. Reconcile below.
    }
  }

  try {
    return await reconcileSsoMemberRows(context, input);
  } catch (error) {
    throw await failedMembershipRedirect(context, input, sessionId, error);
  }
}

/**
 * Add or reconcile a signed-in SSO user's membership of the provider's
 * organization, then audit the sign-in.
 *
 * Rules (the membership step is serialized per `(organizationId, userId)` and
 * its member rows de-duplicated — see {@link ensureSsoMembership}):
 *  1. Not a member: added via `auth.api.addMember`, the same member-added path
 *     an admin invitation uses, so the billing seat hook, workspace provisioning
 *     and `organization.member_added` audit all run.
 *  2. A concurrent sign-in of the same identity (or a race with an invitation)
 *     that reports "already a member" is SUCCESS.
 *  3. The surviving member row, re-read after the add, is reconciled: an `owner`
 *     is untouched; otherwise, when the provider manages roles (`roleManaged`)
 *     and the mapped role differs, the role is updated and
 *     `organization.member_role_changed` is recorded.
 *  4. Every SSO sign-in is recorded as `sso.sign_in`.
 *
 * On a genuine membership failure (a seat taken since sign-in, a billing error, a
 * vanished organization, or a failed member read) the step is NON-DESTRUCTIVE:
 * only the session this sign-in created is revoked, and a redirect to the error
 * URL carrying
 * {@link SSO_ERROR_CODES.seatLimit} (billing seat limit) or
 * {@link SSO_ERROR_CODES.provisioningFailed} (anything else) is thrown — routed
 * through the plugin's own error-URL response, so no session cookie is set.
 * Audit recording and the role-sync write are best-effort: once membership
 * holds the sign-in has succeeded, so their failures are logged, not raised.
 */
export async function provisionSsoUser(input: {
  userId: string;
  organizationId: string;
  role: "member" | "admin";
  providerId: string;
  protocol: SsoSignInProtocol;
  domain: string;
  roleManaged: boolean;
}): Promise<void> {
  // Lazy import breaks the module-load cycle with auth-config (which registers
  // this plugin). Both this and the handling auth instance share one DB.
  const { auth } = await import("../auth/auth");
  const context = (await auth.$context) as unknown as SsoProvisioningContext;

  // Read (and clear) the facts the plugin does not pass to `provisionUser`:
  // whether this sign-in created the user row, and which session it created.
  // Keyed by this request's endpoint context, so concurrent sign-ins of one user
  // never cross-read each other's capture.
  const capture = takeSsoSignInCapture();
  const isNewUser = capture?.userCreated ?? false;

  // Serialize the membership step per (org, user) so concurrent sign-ins of one
  // identity cannot each insert a member row. Any failure in here is turned into
  // the error-URL redirect with the session revoked (never a raw 500).
  const member = await runExclusive(
    membershipLockKey(input.organizationId, input.userId),
    () => ensureSsoMembership(context, auth, input, capture?.sessionId),
  );

  // Reconcile a managed role on the surviving member row. Best-effort: a failure
  // must not undo a sign-in whose membership already holds.
  if (member && input.roleManaged) {
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
        providerId: input.providerId,
        reason: "role_sync_failed",
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
      isNewUser,
    });
  } catch (error) {
    logger.error("sso_sign_in_audit_failed", {
      organizationId: input.organizationId,
      providerId: input.providerId,
      reason: "audit_failed",
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
