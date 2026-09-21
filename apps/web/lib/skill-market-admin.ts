import type {
  RegistryVersionDetail,
  SkillMarketStanding,
} from "@sourceweft/contracts";
import { HttpClient } from "@sourceweft/sdk";

import { apiBaseUrl } from "./api-base-url";

/**
 * Market-admin calls for community skills: the flagged review queue and a
 * skill's standing on the public market. Same allowlist as `market-admin.ts`;
 * everyone else gets 403 from every route here.
 */
const http = new HttpClient({ baseUrl: apiBaseUrl, credentials: "include" });

const ADMIN_BASE = "/v1/skills/registry/admin";

export type SkillReviewSubmission = {
  slug: string;
  skillId: string;
  skillVersionId: string;
  displayName: string;
  description: string;
  submittedBy: string | null;
  capability: "prompt-only" | "executable" | null;
  license: string | null;
  sourceUrl: string | null;
  flags: string[];
  createdAt: string;
  ingestion: Record<string, unknown> | null;
};

export type { SkillMarketStanding };

function skillPath(skillId: string) {
  return `${ADMIN_BASE}/skills/${encodeURIComponent(skillId)}`;
}

function submissionPath(versionId: string) {
  return `${ADMIN_BASE}/submissions/${encodeURIComponent(versionId)}`;
}

/** The routes reject unknown keys and an empty `reason` is just noise. */
export function reviewDecisionBody(reason?: string): { reason?: string } {
  const trimmed = reason?.trim();
  return trimmed ? { reason: trimmed.slice(0, 1000) } : {};
}

export function listSkillReviewQueue(): Promise<{
  items: SkillReviewSubmission[];
}> {
  return http.get(`${ADMIN_BASE}/submissions`);
}

/** A published skill with an advisory flag, waiting for a listing decision. */
export type SkillListingQueueEntry = Omit<SkillReviewSubmission, "ingestion">;

export function listSkillListingQueue(): Promise<{
  items: SkillListingQueueEntry[];
}> {
  return http.get(`${ADMIN_BASE}/listing-queue`);
}

export function publishSkillSubmission(versionId: string, reason?: string) {
  return http.post<unknown>(
    `${submissionPath(versionId)}/publish`,
    reviewDecisionBody(reason),
  );
}

export function rejectSkillSubmission(versionId: string, reason?: string) {
  return http.post<unknown>(
    `${submissionPath(versionId)}/reject`,
    reviewDecisionBody(reason),
  );
}

/** A version as an admin sees it — SKILL.md text included, whatever its state. */
export function getSkillReviewVersion(skillId: string, versionId: string) {
  return http.get<RegistryVersionDetail>(
    `${skillPath(skillId)}/versions/${encodeURIComponent(versionId)}`,
  );
}

export function getSkillMarketStanding(skillId: string) {
  return http.get<SkillMarketStanding>(`${skillPath(skillId)}/market`);
}

export function listSkillPublicly(skillId: string) {
  return http.post<SkillMarketStanding>(`${skillPath(skillId)}/list`, {});
}

export function delistSkill(skillId: string) {
  return http.post<SkillMarketStanding>(`${skillPath(skillId)}/delist`, {});
}

export function setSkillVerified(skillId: string, verified: boolean) {
  return http.put<SkillMarketStanding>(`${skillPath(skillId)}/verified`, {
    verified,
  });
}

export function setSkillCategories(skillId: string, categorySlugs: string[]) {
  return http.put<SkillMarketStanding>(`${skillPath(skillId)}/categories`, {
    categorySlugs,
  });
}

/** 403 (not an admin) and 404 (no such market skill): no panel, no noise. */
export function isSkillMarketAdminUnavailable(error: unknown) {
  const status = (error as { status?: unknown } | null)?.status;
  return status === 401 || status === 403 || status === 404;
}
