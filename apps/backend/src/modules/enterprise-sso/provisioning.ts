import { billingOrganizationHooks } from "../../billing-host/bindings";
import { parseSourceweftOrganizationKind } from "../auth/organization-metadata";
import {
  recordSsoMemberRoleChangeAudit,
  recordSsoSignInAudit,
  type SsoAuditProtocol,
} from "./audit";
import { SSO_ERROR_CODES } from "./errors";

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

function reject(code: string, message: string): SsoUserResolution {
  return { action: "reject", code, message };
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
    return reject(
      SSO_ERROR_CODES.providerNotFound,
      "No SSO provider matched this sign-in.",
    );
  }

  const organizationId = asNonEmptyString(provider.organizationId);
  const domain = asNonEmptyString(provider.domain);
  if (!organizationId || !domain) {
    return reject(
      SSO_ERROR_CODES.organizationRequired,
      "This SSO provider is not bound to a team organization.",
    );
  }
  if (provider.domainVerified !== true) {
    return reject(
      SSO_ERROR_CODES.domainNotVerified,
      "This SSO provider's domain is not verified.",
    );
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
    return reject(
      SSO_ERROR_CODES.organizationRequired,
      "This SSO provider's organization is no longer a team organization.",
    );
  }

  // Fail closed on a domain mismatch: an identity whose email domain is not
  // covered by the verified domain must never link to an existing account nor
  // create one. This also rejects an email with no domain part.
  if (!emailDomainMatchesProviderDomain(email, domain)) {
    return reject(
      SSO_ERROR_CODES.accountLinkDenied,
      "This identity's email domain is not covered by a verified SSO domain.",
    );
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
      return reject(
        SSO_ERROR_CODES.seatLimit,
        "The organization has no available seat for this member.",
      );
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
    update: (args: {
      model: string;
      where: Array<{ field: string; value: unknown }>;
      update: Record<string, unknown>;
    }) => Promise<unknown>;
  };
  internalAdapter: {
    updateUser: (
      userId: string,
      data: Record<string, unknown>,
    ) => Promise<unknown>;
  };
};

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
 * `role` is already mapped (never `owner`). `isNewUser` only labels the audit
 * entry and, for a freshly created account, confirms the email as verified:
 * ownership is proven by the verified domain + matching email, so the account is
 * verified without trusting the IdP's own `email_verified` claim.
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

  if (input.isNewUser) {
    // A new account is created with emailVerified=false (trustEmailVerified is
    // never set). The verified domain + matching email already prove ownership,
    // so mark it verified now rather than mailing a redundant confirmation.
    await context.internalAdapter.updateUser(input.userId, {
      emailVerified: true,
    });
  }

  const member = await context.adapter.findOne({
    model: "member",
    where: [
      { field: "organizationId", value: input.organizationId },
      { field: "userId", value: input.userId },
    ],
    select: ["id", "role"],
  });

  if (!member) {
    await auth.api.addMember({
      body: {
        userId: input.userId,
        organizationId: input.organizationId,
        role: input.role,
      },
    });
  } else {
    const currentRole = typeof member.role === "string" ? member.role : "";
    const isOwner = currentRole
      .split(",")
      .map((entry) => entry.trim())
      .includes("owner");

    if (!isOwner && input.roleManaged && currentRole !== input.role) {
      await context.adapter.update({
        model: "member",
        where: [{ field: "id", value: String(member.id) }],
        update: { role: input.role },
      });
      await recordSsoMemberRoleChangeAudit({
        teamId: input.organizationId,
        userId: input.userId,
        previousRole: currentRole,
        newRole: input.role,
      });
    }
  }

  await recordSsoSignInAudit({
    teamId: input.organizationId,
    actorUserId: input.userId,
    providerId: input.providerId,
    protocol: input.protocol,
    domain: input.domain,
    isNewUser: input.isNewUser,
  });
}
