import { recordSkillMarketEvent } from "./events";
import { enqueueSkillOverviewJob } from "./overview-queue";
import {
  checkSkillOverviewBillingTarget,
  countSkillOverviewCoverage,
  findSkillOverviewAdminState,
  readSkillOverviewBilling,
  setSkillOverviewsHidden,
  writeSkillOverviewBilling,
  type SkillOverviewBillingProblem,
  type SkillOverviewBillingTarget,
} from "./overview-repository";

/**
 * The market admin's hands on AI overviews: who pays for them, and for one
 * skill, regenerate or hide. Every change is audited.
 */

export async function setSkillOverviewBilling(input: {
  teamId: string;
  workspaceId: string;
  userId: string;
  actorUserId: string;
}): Promise<
  | { ok: true; billing: SkillOverviewBillingTarget }
  | { ok: false; problem: SkillOverviewBillingProblem }
> {
  const billing = {
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    userId: input.userId,
  };
  const problem = await checkSkillOverviewBillingTarget(billing);
  if (problem) return { ok: false, problem };
  const before = await readSkillOverviewBilling();
  await writeSkillOverviewBilling({ billing, updatedBy: input.actorUserId });
  await recordSkillMarketEvent({
    actorKind: "admin",
    actorUserId: input.actorUserId,
    action: "settings.updated",
    detail: {
      key: "overview.billing",
      before: before.billing,
      after: billing,
    },
  });
  return { ok: true, billing };
}

/**
 * Keeps the current version's overviews and queues a replacement. Null when
 * there is no such skill or it has no current version; `queued` is false for
 * a skill overviews are not written for.
 */
export async function regenerateSkillOverview(input: {
  skillId: string;
  actorUserId: string;
  expectedVersionId?: string;
}): Promise<{
  skillId: string;
  skillVersionId: string;
  deleted: number;
  queued: boolean;
} | null> {
  const state = await findSkillOverviewAdminState(input.skillId);
  if (!state?.skillVersionId) return null;
  const skillVersionId = state.skillVersionId;
  if (input.expectedVersionId && input.expectedVersionId !== skillVersionId)
    return null;
  const deleted = 0; // Existing output stays live until an atomic replacement succeeds.
  let queued = false;
  if (state.eligible) {
    const { billing } = await readSkillOverviewBilling();
    // A fresh id: the scheduled one may still be held by a finished or
    // failed job, which would swallow this request.
    await enqueueSkillOverviewJob({
      skillVersionId,
      skillId: input.skillId,
      reason: "regenerate",
      ...(billing
        ? { teamId: billing.teamId, workspaceId: billing.workspaceId }
        : {}),
    });
    queued = true;
  }
  await recordSkillMarketEvent({
    skillId: input.skillId,
    actorKind: "admin",
    actorUserId: input.actorUserId,
    action: "overview.regenerated",
    detail: { skillVersionId, deleted, queued },
  });
  return { skillId: input.skillId, skillVersionId, deleted, queued };
}

/**
 * Hides or shows every language of the current version's overview. Null when
 * there is no such skill or it has no overview to hide.
 */
export async function setSkillOverviewVisibility(input: {
  skillId: string;
  hidden: boolean;
  actorUserId: string;
}): Promise<{
  skillId: string;
  skillVersionId: string;
  hidden: boolean;
  updated: number;
} | null> {
  const state = await findSkillOverviewAdminState(input.skillId);
  if (!state?.skillVersionId || state.overviews.length === 0) return null;
  const updated = await setSkillOverviewsHidden({
    skillVersionId: state.skillVersionId,
    hidden: input.hidden,
  });
  if (updated > 0) {
    await recordSkillMarketEvent({
      skillId: input.skillId,
      actorKind: "admin",
      actorUserId: input.actorUserId,
      action: input.hidden ? "overview.hidden" : "overview.shown",
      detail: { skillVersionId: state.skillVersionId, locales: updated },
    });
  }
  return {
    skillId: input.skillId,
    skillVersionId: state.skillVersionId,
    hidden: input.hidden,
    updated,
  };
}

export async function getSkillOverviewStatus() {
  const [coverage, { billing }] = await Promise.all([
    countSkillOverviewCoverage(),
    readSkillOverviewBilling(),
  ]);
  return {
    billingConfigured: billing !== null,
    eligible: coverage.eligible,
    withOverview: coverage.withOverview,
    missing: Math.max(0, coverage.eligible - coverage.withOverview),
    hidden: coverage.hidden,
  };
}
