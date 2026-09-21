import type {
  GetSkillOverviewAdminResponse,
  GetSkillOverviewBillingResponse,
  PutSkillOverviewBillingRequest,
  RegenerateSkillOverviewResponse,
  SetSkillOverviewVisibilityResponse,
  SkillMarketAdminMeResponse,
  SkillOverviewStatusResponse,
} from "@sourceweft/contracts";
import type {
  GetMarketSkillResponse,
  MarketSkillAiOverview,
  MarketSkillLocale,
} from "@sourceweft/market-sdk";
import { HttpClient } from "@sourceweft/sdk";

import { apiBaseUrl } from "./api-base-url";

/**
 * AI overviews of market skills (skill-marketplace-plan §17.4): the public
 * read the dashboard shows, and the market admin's controls. Admin routes
 * answer 403 to everyone else.
 */
const http = new HttpClient({ baseUrl: apiBaseUrl, credentials: "include" });

const ADMIN_BASE = "/v1/skills/registry/admin";

export type {
  GetSkillOverviewAdminResponse,
  GetSkillOverviewBillingResponse,
  MarketSkillAiOverview,
  MarketSkillLocale,
  SkillOverviewStatusResponse,
};

const LOCALES: readonly MarketSkillLocale[] = ["en", "zh-CN", "zh-TW"];

/** The app's locale as one overviews are written in; English otherwise. */
export function overviewLocale(locale: string | null | undefined) {
  return (LOCALES as readonly string[]).includes(locale ?? "")
    ? (locale as MarketSkillLocale)
    : "en";
}

function isNotFound(error: unknown) {
  const status = (error as { status?: unknown } | null)?.status;
  return status === 404;
}

/**
 * A public skill's AI overview in `locale` (English when that one is
 * missing), through the public detail. Null when the skill has none, or is
 * not public (the public API answers 404 for a restricted skill).
 */
export async function getSkillAiOverview(
  slug: string,
  locale: MarketSkillLocale,
): Promise<MarketSkillAiOverview | null> {
  try {
    const detail = await http.get<GetMarketSkillResponse>(
      `/v1/skills/${encodeURIComponent(slug)}?locale=${encodeURIComponent(locale)}`,
    );
    return detail.aiOverview ?? null;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/** Whether the signed-in user is a market admin. False on any failure. */
export async function getSkillMarketAdminMe(): Promise<boolean> {
  try {
    const me = await http.get<SkillMarketAdminMeResponse>(`${ADMIN_BASE}/me`);
    return me.isMarketAdmin === true;
  } catch {
    return false;
  }
}

function overviewPath(skillId: string) {
  return `${ADMIN_BASE}/skills/${encodeURIComponent(skillId)}/overview`;
}

export function getSkillOverviewAdmin(skillId: string) {
  return http.get<GetSkillOverviewAdminResponse>(overviewPath(skillId));
}

/** Deletes the current version's overview and queues a new one. */
export function regenerateSkillOverview(skillId: string) {
  return http.post<RegenerateSkillOverviewResponse>(
    `${overviewPath(skillId)}/regenerate`,
    {},
  );
}

export function setSkillOverviewHidden(skillId: string, hidden: boolean) {
  return http.post<SetSkillOverviewVisibilityResponse>(
    `${overviewPath(skillId)}/visibility`,
    { hidden },
  );
}

export function getSkillOverviewBilling() {
  return http.get<GetSkillOverviewBillingResponse>(
    `${ADMIN_BASE}/settings/overview-billing`,
  );
}

/** `userId` omitted bills the admin making the change. */
export function setSkillOverviewBilling(input: PutSkillOverviewBillingRequest) {
  return http.put<GetSkillOverviewBillingResponse>(
    `${ADMIN_BASE}/settings/overview-billing`,
    input,
  );
}

export function getSkillOverviewStatus() {
  return http.get<SkillOverviewStatusResponse>(
    `${ADMIN_BASE}/overviews/status`,
  );
}
