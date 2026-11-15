import { database } from "@sourceweft/db";
import { logger } from "../../shared/logger";
import { parseSourceweftOrganizationKind } from "../auth/organization-metadata";
import { buildSsoProviderAuditEntry, recordSsoProviderAudit } from "./audit";

/**
 * Organization- and user-deletion lifecycle for enterprise SSO providers.
 *
 * `@better-auth/sso`'s `ssoProvider` and the `account` rows linked through it
 * are better-auth tables, outside the drizzle schema and with no deletion hooks
 * of their own, so the two cleanup paths live here and are wired into the
 * existing `organizationHooks.beforeDeleteOrganization` and user `beforeDelete`
 * in auth-config.ts. Both run raw SQL against the auth tables on the shared
 * `@sourceweft/db` pool, the same way `assertUserHardDeleteAllowed` does.
 */

type SsoProviderRow = {
  providerId: string;
  domain: string | null;
  samlConfig: string | null;
};

/**
 * Delete an organization's SSO providers and the `account` rows linked through
 * them when the organization is deleted.
 *
 * Without this, a deleted team's verified `ssoProvider` row keeps blocking its
 * domain for every other team (the partial unique index) while nobody can remove
 * it (`checkProviderAccess` needs org-admin membership of an organization that no
 * longer exists). Runs in the org's `beforeDeleteOrganization` hook, so the
 * audit sink still exists; the audit write is best-effort.
 */
export async function deleteSsoProvidersForOrganization(input: {
  organizationId: string;
  actorUserId: string | null;
}): Promise<void> {
  const { rows } = await database.query<SsoProviderRow>(
    `select "providerId", "domain", "samlConfig"
       from "ssoProvider" where "organizationId" = $1`,
    [input.organizationId],
  );
  for (const row of rows) {
    // Remove the SSO account rows first (their `providerId` is the ssoProvider's
    // providerId), then the provider row itself.
    await database.query(`delete from account where "providerId" = $1`, [
      row.providerId,
    ]);
    await database.query(`delete from "ssoProvider" where "providerId" = $1`, [
      row.providerId,
    ]);
    try {
      await recordSsoProviderAudit(
        buildSsoProviderAuditEntry({
          action: "sso.provider_deleted",
          teamId: input.organizationId,
          actorUserId: input.actorUserId,
          provider: {
            providerId: row.providerId,
            domain: row.domain ?? "",
            samlConfig: row.samlConfig,
          },
        }),
      );
    } catch (error) {
      logger.warn("sso_provider_delete_audit_failed", {
        organizationId: input.organizationId,
        providerId: row.providerId,
        reason: "org_deletion",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * Reassign a departing user's team SSO providers to a surviving team owner (or,
 * failing that, an admin) before their account is deleted.
 *
 * `ssoProvider.userId` references `user` with ON DELETE CASCADE, so deleting the
 * admin who registered a team's provider would silently delete that team's
 * identity source and orphan its linked `account` rows. Access to a team-bound
 * provider is by org-admin membership (`checkProviderAccess` uses `isOrgAdmin`,
 * not `provider.userId`), so reassigning `userId` locks nobody out; it only
 * moves the per-user `providersLimit` count onto the new owner, and keeps the
 * row alive.
 *
 * A personal organization's provider is left to cascade (personal orgs never own
 * SSO providers in practice). If a team has no other owner or admin, the user is
 * that team's sole owner, which `assertUserHardDeleteAllowed` has already
 * rejected before this runs — so a team provider never silently vanishes.
 */
export async function reassignSsoProvidersOnUserDelete(
  userId: string,
): Promise<void> {
  const { rows } = await database.query<{
    providerId: string;
    organizationId: string;
    metadata: string | null;
  }>(
    `select p."providerId", p."organizationId", o.metadata
       from "ssoProvider" p
       join organization o on o.id = p."organizationId"
      where p."userId" = $1`,
    [userId],
  );
  for (const row of rows) {
    if (parseSourceweftOrganizationKind(row.metadata) !== "team") {
      continue;
    }
    const successor = await findOrganizationSuccessor(
      row.organizationId,
      userId,
    );
    if (!successor) {
      // Should be unreachable: a team with no other owner/admin means the
      // departing user is its sole owner, which blocks deletion upstream.
      logger.warn("sso_provider_reassign_no_successor", {
        organizationId: row.organizationId,
        providerId: row.providerId,
        reason: "user_deletion",
      });
      continue;
    }
    await database.query(
      `update "ssoProvider" set "userId" = $2 where "providerId" = $1`,
      [row.providerId, successor],
    );
  }
}

/** Another owner of the organization, else an admin; `null` if neither exists. */
async function findOrganizationSuccessor(
  organizationId: string,
  excludeUserId: string,
): Promise<string | null> {
  const { rows } = await database.query<{ userId: string; role: string | null }>(
    `select "userId", role from member
      where "organizationId" = $1 and "userId" <> $2`,
    [organizationId, excludeUserId],
  );
  // Roles may be comma-joined (e.g. "owner,admin"); split and match an exact
  // entry, preferring an owner over an admin.
  const roleEntries = (role: string | null): string[] =>
    (role ?? "").split(",").map((entry) => entry.trim());
  const owner = rows.find((member) => roleEntries(member.role).includes("owner"));
  if (owner) {
    return owner.userId;
  }
  const admin = rows.find((member) => roleEntries(member.role).includes("admin"));
  return admin?.userId ?? null;
}
