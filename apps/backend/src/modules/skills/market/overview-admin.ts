import { getSystemModelReadiness } from "../../../shared/model-gateway/system-client";
import { recordSkillMarketEvent } from "./events";
import { enqueueSkillOverviewJob } from "./overview-queue";
import {
  countSkillOverviewCoverage,
  findSkillOverviewAdminState,
  setSkillOverviewsHidden,
} from "./overview-repository";

/**
 * The market admin's hands on AI overviews: whether the system model can
 * write them, and for one skill, regenerate or hide. Every change is audited.
 */

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
    // A fresh id: the scheduled one may still be held by a finished or
    // failed job, which would swallow this request.
    await enqueueSkillOverviewJob({
      skillVersionId,
      skillId: input.skillId,
      reason: "regenerate",
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
  const [coverage, readiness] = await Promise.all([
    countSkillOverviewCoverage(),
    getSystemModelReadiness(),
  ]);
  return {
    // Names settings and the Provider/model, never the key.
    systemModel: {
      enabled: readiness.enabled,
      configured: readiness.configured,
      ready: readiness.ready,
      provider: readiness.provider,
      model: readiness.model,
      problems: readiness.problems,
      reason: readiness.reason,
    },
    eligible: coverage.eligible,
    withOverview: coverage.withOverview,
    missing: Math.max(0, coverage.eligible - coverage.withOverview),
    hidden: coverage.hidden,
  };
}
