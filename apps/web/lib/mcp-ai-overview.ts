import { HttpClient } from "@sourceweft/sdk";

import { apiBaseUrl } from "./api-base-url";

/**
 * AI overviews of MCP servers (#152): the shapes the API sends, read
 * defensively, and the reads and market-admin controls the dashboard uses.
 * Admin routes answer 403 to everyone but a market admin.
 */

// TODO(#152): replace with @sourceweft/market-contracts types once C2 lands.
// Until then these fields are read from untyped answers: the market SDK's
// response schemas do not name them yet, and strip them.

/** Languages the market writes MCP overviews in. */
export const MCP_OVERVIEW_LOCALES = ["en", "zh-CN", "zh-TW"] as const;

export type MarketMcpOverviewLocale = (typeof MCP_OVERVIEW_LOCALES)[number];

/**
 * An MCP server's AI-written overview (`aiOverview` on the MCP detail), in
 * the requested language or English when that one is missing. Model output
 * from third-party content: plain text, labelled as AI-generated wherever it
 * is shown.
 */
export type MarketMcpAiOverview = {
  summary: string;
  whatItDoes: string;
  whenToUse: string;
  // "" when it needs nothing.
  requirements: string;
  // What to know before installing; null when there is nothing.
  cautions: string | null;
  // The language it is actually in.
  locale: MarketMcpOverviewLocale;
  generatedAt: string;
};

/** One language's overview, as the market admin sees it. */
export type McpOverviewAdminEntry = {
  locale: MarketMcpOverviewLocale;
  model: string;
  hidden: boolean;
  generatedAt: string;
};

/** `GET /v1/market/admin/mcp/:identifier/overview`. */
export type McpOverviewAdminState = {
  entries: McpOverviewAdminEntry[];
  // The latest analysis run; null before the first one.
  analysis: { status: string; error: string | null } | null;
  // Who set the server's categories: `auto`, `ai` or `admin`; null for none.
  categoriesSource: string | null;
  // Whether overviews are written for this server at all.
  eligible: boolean;
  // Whether the system model can write overviews; null when not reported.
  systemModel: { ready: boolean; reason: string | null } | null;
};

/** What the public MCP detail says about the server's AI overview. */
export type McpOverviewDetail = {
  aiOverview: MarketMcpAiOverview | null;
  // The item's visible overview languages, without fallback; null when the
  // answer does not name them.
  overviewLocales: MarketMcpOverviewLocale[] | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOf(value: unknown) {
  return typeof value === "string" ? value : "";
}

export function isMcpOverviewLocale(
  value: unknown,
): value is MarketMcpOverviewLocale {
  return (
    typeof value === "string" &&
    (MCP_OVERVIEW_LOCALES as readonly string[]).includes(value)
  );
}

/** The app's locale as one overviews are written in; English otherwise. */
export function mcpOverviewLocale(
  locale: string | null | undefined,
): MarketMcpOverviewLocale {
  return isMcpOverviewLocale(locale) ? locale : "en";
}

/**
 * An `aiOverview` as the API sends it. Null when there is none, or when it is
 * malformed: no summary, or no language it names, so a fallback could not be
 * told from an answer in the language asked for.
 */
export function readMcpAiOverview(value: unknown): MarketMcpAiOverview | null {
  if (!isRecord(value) || !isMcpOverviewLocale(value.locale)) return null;
  const summary = stringOf(value.summary).trim();
  if (!summary) return null;
  const cautions = stringOf(value.cautions);
  return {
    summary,
    whatItDoes: stringOf(value.whatItDoes),
    whenToUse: stringOf(value.whenToUse),
    requirements: stringOf(value.requirements),
    cautions: cautions.trim() ? cautions : null,
    locale: value.locale,
    generatedAt: stringOf(value.generatedAt),
  };
}

/** A list item's `aiSummary`; null when it has none worth showing. */
export function readMcpAiSummary(item: unknown): string | null {
  if (!isRecord(item)) return null;
  return stringOf(item.aiSummary).trim() || null;
}

/**
 * An item's `overviewLocales`: the languages it has a visible overview in.
 * Null when the item does not say, which is not the same as none.
 */
export function readMcpOverviewLocales(
  item: unknown,
): MarketMcpOverviewLocale[] | null {
  if (!isRecord(item) || !Array.isArray(item.overviewLocales)) return null;
  const named: unknown[] = item.overviewLocales;
  return MCP_OVERVIEW_LOCALES.filter((id) => named.includes(id));
}

/** The overview parts of an MCP detail answer (`GET /v1/mcp/:identifier`). */
export function readMcpOverviewDetail(detail: unknown): McpOverviewDetail {
  if (!isRecord(detail)) return { aiOverview: null, overviewLocales: null };
  return {
    aiOverview: readMcpAiOverview(detail.aiOverview),
    overviewLocales: readMcpOverviewLocales(detail.item),
  };
}

/**
 * What a card says about an MCP server: the AI summary when the market has
 * one, else the registry's own summary. Plain text either way.
 *
 * TODO(#152): the list reads send no `locale` yet (neither the market SDK's
 * `listMcp` nor the workspace client takes one), so `aiSummary` comes in the
 * API's default language until C2's clients pass the visitor's.
 */
export function mcpCardText(item: { summary: string }): {
  text: string;
  ai: boolean;
} {
  const summary = readMcpAiSummary(item);
  return summary
    ? { text: summary, ai: true }
    : { text: item.summary, ai: false };
}

/** The admin view of one server's overview, read field by field. */
export function readMcpOverviewAdminState(
  value: unknown,
): McpOverviewAdminState {
  const body = isRecord(value) ? value : {};
  const entries = Array.isArray(body.entries)
    ? body.entries.flatMap((entry: unknown) =>
        isRecord(entry) && isMcpOverviewLocale(entry.locale)
          ? [
              {
                locale: entry.locale,
                model: stringOf(entry.model),
                hidden: entry.hidden === true,
                generatedAt: stringOf(entry.generatedAt),
              },
            ]
          : [],
      )
    : [];
  const analysis = isRecord(body.analysis)
    ? {
        status: stringOf(body.analysis.status),
        error: stringOf(body.analysis.error) || null,
      }
    : null;
  const systemModel = isRecord(body.systemModel)
    ? {
        ready: body.systemModel.ready === true,
        reason: stringOf(body.systemModel.reason) || null,
      }
    : null;
  return {
    entries,
    analysis,
    categoriesSource: stringOf(body.categoriesSource) || null,
    eligible: body.eligible === true,
    systemModel,
  };
}

const http = new HttpClient({ baseUrl: apiBaseUrl, credentials: "include" });

function isNotFound(error: unknown) {
  return (error as { status?: unknown } | null)?.status === 404;
}

function detailPath(identifier: string) {
  return `/v1/mcp/${encodeURIComponent(identifier)}`;
}

function adminPath(identifier: string) {
  return `/v1/market/admin/mcp/${encodeURIComponent(identifier)}/overview`;
}

/**
 * A public MCP server's AI overview in `locale` (English when that one is
 * missing), through the public detail. Null when the server has none, or is
 * not public (the public API answers 404).
 */
export async function getMcpAiOverview(
  identifier: string,
  locale: MarketMcpOverviewLocale,
): Promise<MarketMcpAiOverview | null> {
  try {
    const detail = await http.get<unknown>(
      `${detailPath(identifier)}?locale=${encodeURIComponent(locale)}`,
    );
    return readMcpOverviewDetail(detail).aiOverview;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

// Market admins are one allowlist for skills and MCP servers alike; this is
// its check.
export { getSkillMarketAdminMe as getMarketAdminMe } from "./skill-overviews";

export async function getMcpOverviewAdmin(identifier: string) {
  return readMcpOverviewAdminState(
    await http.get<unknown>(adminPath(identifier)),
  );
}

/**
 * Queues a fresh overview while the current one stays up. `queued` is false
 * when the API says nothing was queued, null when it does not say.
 */
export async function regenerateMcpOverview(
  identifier: string,
): Promise<{ queued: boolean | null }> {
  const result = await http.post<unknown>(
    `${adminPath(identifier)}/regenerate`,
    {},
  );
  return {
    queued:
      isRecord(result) && typeof result.queued === "boolean"
        ? result.queued
        : null,
  };
}

/** Hides (or shows again) every language of the server's overview. */
export async function setMcpOverviewHidden(
  identifier: string,
  hidden: boolean,
): Promise<void> {
  await http.post<unknown>(`${adminPath(identifier)}/hidden`, { hidden });
}
