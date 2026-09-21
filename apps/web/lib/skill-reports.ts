import type {
  CreateSkillReportRequest,
  CreateSkillReportResponse,
  ListSkillReportsResponse,
  ResolveSkillReportRequest,
  ResolveSkillReportResponse,
  SkillReportItem,
  SkillReportReason,
  SkillReportStatus,
} from "@sourceweft/contracts";
import { HttpClient, HttpClientError } from "@sourceweft/sdk";

import { apiBaseUrl } from "./api-base-url";

/**
 * Skill reports (§17.2): anyone reporting a skill or one of its reviews, and
 * the market admins' queue of them. Submitting works signed in or out; a
 * visitor who is not signed in must leave an email address.
 */
const http = new HttpClient({ baseUrl: apiBaseUrl, credentials: "include" });

const ADMIN_BASE = "/v1/skills/registry/admin/reports";

export type {
  SkillReportItem,
  SkillReportReason,
  SkillReportStatus,
  ResolveSkillReportRequest,
};
export type SkillReportAction = ResolveSkillReportRequest["action"];

/** The body the route accepts: no empty fields, since it rejects blanks as noise. */
export function skillReportBody(input: {
  reason: SkillReportReason;
  details?: string;
  contactEmail?: string;
  reviewId?: string;
}): Partial<CreateSkillReportRequest> & { reason: SkillReportReason } {
  const body: Partial<CreateSkillReportRequest> & {
    reason: SkillReportReason;
  } = { reason: input.reason };
  const details = input.details?.trim();
  if (details) body.details = details.slice(0, 4000);
  const contactEmail = input.contactEmail?.trim();
  if (contactEmail) body.contactEmail = contactEmail;
  if (input.reviewId) body.reviewId = input.reviewId;
  return body;
}

export function submitSkillReport(
  slug: string,
  input: Parameters<typeof skillReportBody>[0],
) {
  return http.post<CreateSkillReportResponse>(
    `/v1/skills/${encodeURIComponent(slug)}/reports`,
    skillReportBody(input),
  );
}

/** Why a report was refused, as the form tells the reporter. */
export type SkillReportFailure =
  | { kind: "rate_limited"; retryAfterSeconds: number | null }
  | { kind: "contact_required" }
  | { kind: "invalid" }
  | { kind: "not_found" }
  | { kind: "unknown" };

export function describeSkillReportError(error: unknown): SkillReportFailure {
  if (!(error instanceof HttpClientError)) return { kind: "unknown" };
  if (error.status === 429) {
    const seconds = Number(error.details?.retryAfterSeconds);
    return {
      kind: "rate_limited",
      retryAfterSeconds:
        Number.isFinite(seconds) && seconds > 0 ? seconds : null,
    };
  }
  if (error.code === "SKILL_REPORT_CONTACT_REQUIRED") {
    return { kind: "contact_required" };
  }
  if (error.status === 400) return { kind: "invalid" };
  if (error.status === 404) return { kind: "not_found" };
  return { kind: "unknown" };
}

export function listSkillReports(input: {
  status: SkillReportStatus;
  cursor?: string | null;
  limit?: number;
}) {
  const query = new URLSearchParams({ status: input.status });
  if (input.cursor) query.set("cursor", input.cursor);
  if (input.limit) query.set("limit", String(input.limit));
  return http.get<ListSkillReportsResponse>(`${ADMIN_BASE}?${query}`);
}

export function resolveSkillReport(
  reportId: string,
  input: ResolveSkillReportRequest,
) {
  const resolution = input.resolution?.trim();
  return http.post<ResolveSkillReportResponse>(
    `${ADMIN_BASE}/${encodeURIComponent(reportId)}/resolve`,
    {
      action: input.action,
      ...(resolution ? { resolution: resolution.slice(0, 1000) } : {}),
      ...(input.alsoResolveSameTarget ? { alsoResolveSameTarget: true } : {}),
    },
  );
}
