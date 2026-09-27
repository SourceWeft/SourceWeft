import type { SkillAnalysisClassification } from "@sourceweft/db";
import type { OverviewStore } from "../../catalog-overview/types";
import {
  claimSkillAnalysis,
  failSkillAnalysis,
  findCachedSkillAnalysis,
  findInterruptedSkillAnalyses,
  publishSkillAnalysis,
  readSkillAnalysis,
  requestSkillAnalysis,
} from "./analysis-repository";

/** What publishing a skill overview needs to know about its version. */
export type SkillOverviewTarget = {
  skillId: string;
  skillVersionId: string;
  bundleSha256: string;
};

/**
 * The skill kind's storage as the overview engine sees it: the functions of
 * `analysis-repository.ts`, looked up on each call rather than captured, so
 * that module stays the one seam for the skill tables (and for tests that
 * replace it).
 */
export const skillOverviewStore: OverviewStore<
  SkillOverviewTarget,
  SkillAnalysisClassification
> = {
  read: (versionId) => readSkillAnalysis(versionId),
  request: (versionId, force) => requestSkillAnalysis(versionId, force),
  claim: (versionId, requestId) => claimSkillAnalysis(versionId, requestId),
  fail: (versionId, requestId, error, retry) =>
    failSkillAnalysis(versionId, requestId, error, retry),
  findCached: (resultKey, versionId) =>
    findCachedSkillAnalysis(resultKey, versionId),
  publish: ({ subject, ...input }) =>
    publishSkillAnalysis({
      ...input,
      skillId: subject.skillId,
      skillVersionId: subject.skillVersionId,
      bundleSha256: subject.bundleSha256,
    }),
  findInterrupted: async () =>
    (await findInterruptedSkillAnalyses()).map((row) => ({
      versionId: row.skillVersionId,
      parentId: row.skillId,
      requestId: row.requestId,
      force: row.force,
    })),
};
