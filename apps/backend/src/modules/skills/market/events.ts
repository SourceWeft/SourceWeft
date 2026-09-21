import { randomUUID } from "node:crypto";
import {
  db,
  skillMarketEvents,
  type SkillMarketEventActorKind,
} from "@sourceweft/db";
import { logger } from "../../../shared/logger";

/**
 * The skill market's audit trail (`skill_market_events`): who did what to a
 * skill's market standing, and what the platform did by itself. Append-only;
 * read by the admin panel.
 *
 * Actions are dotted verbs, grouped by what they change:
 * - `listing.listed` / `listing.withdrawn` / `listing.auto_listed` /
 *   `listing.owner_allowed` / `listing.owner_private` / `listing.kept`
 * - `verified.set` / `verified.cleared` (a new version cleared it)
 * - `featured.set`
 * - `categories.set` / `categories.reinferred`
 * - `provenance.withheld`
 * - `claim.granted` / `claim.revoked` / `claim.removed` / `claim.restored`
 * - `version.published` / `version.rejected` / `version.revoked`
 * - `review.hidden` / `review.shown`
 * - `report.actioned` / `report.dismissed`
 * - `overview.regenerated` / `overview.hidden` / `overview.shown`
 * - `settings.updated`
 */
export type SkillMarketEventInput = {
  skillId?: string | null;
  repo?: { owner: string; name: string } | null;
  actorKind: SkillMarketEventActorKind;
  actorUserId?: string | null;
  action: string;
  // Small and structured: before/after values, a reason, a version id. Never
  // a skill's content, a command, or anything a reporter wrote in private.
  detail?: Record<string, unknown>;
};

type Executor = Pick<typeof db, "insert">;

/**
 * Records one event. Pass the transaction (`tx`) that made the change so the
 * event commits with it; without one, a failure to record is logged and never
 * undoes or fails the change it describes.
 */
export async function recordSkillMarketEvent(
  input: SkillMarketEventInput,
  executor?: Executor,
): Promise<void> {
  const row = {
    id: randomUUID(),
    skillId: input.skillId ?? null,
    repoOwner: input.repo?.owner ?? null,
    repoName: input.repo?.name ?? null,
    actorKind: input.actorKind,
    actorUserId: input.actorUserId ?? null,
    action: input.action,
    detail: input.detail ?? {},
  };
  if (executor) {
    await executor.insert(skillMarketEvents).values(row);
    return;
  }
  try {
    await db.insert(skillMarketEvents).values(row);
  } catch (error) {
    logger.warn("Failed to record a skill market event", {
      action: input.action,
      skillId: input.skillId ?? null,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
