import { isPersonalOrganization } from "@sourceweft/contracts/organization-metadata";
import { formatCopy, type BillingCopy } from "../messages";
import type { BillingCopyFormat } from "./use-billing-copy";
import type {
  BillingInterval,
  BillingLedgerEntry,
  BillingOrg,
  BillingScope,
  BillingSummary,
  SeatPreview,
  UsageActivityFilter,
  UsageActivityKind,
} from "./types";

export const USAGE_ACTIVITY_PAGE_SIZE = 20;
export const ACTIVE_SUBSCRIPTION_STATUSES = new Set(["active", "past_due"]);
/**
 * The activity filter values, in display order. Labels come from
 * `copy.usage.filters[value]` at render time — this only enumerates which
 * filters exist, so it stays locale-independent.
 */
export const usageActivityFilters = [
  "all",
  "seat",
  "page",
  "credit",
] as const satisfies ReadonlyArray<UsageActivityFilter>;

export function resolveBillingTeamId(input: {
  activeOrg?: BillingOrg | null;
  orgs?: BillingOrg[] | null;
}) {
  if (input.activeOrg?.id) {
    return input.activeOrg.id;
  }

  const personalOrg = input.orgs?.find(isPersonalOrganization);
  return personalOrg?.id ?? null;
}

export function isPersonalBillingOrg(org?: BillingOrg | null) {
  return !org || Boolean(isPersonalOrganization(org));
}

export function createBillingReferenceKey(
  scope: BillingScope,
  interval: BillingInterval,
) {
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `settings-billing:${scope}:${interval}:${id}`;
}

export function isNonFreePlanFamily(planFamily: string | null | undefined) {
  return Boolean(planFamily && planFamily !== "individual_free");
}

export function openBillingPortalWindow(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
}

export function formatPlanName(
  planFamily: string,
  personal: boolean,
  copy: BillingCopy,
) {
  const planNames = copy.common.planNames as Record<string, string>;
  return (
    planNames[planFamily] ??
    (personal ? copy.common.personal : copy.common.team)
  );
}

export function formatFeatureName(feature: string) {
  const label = feature
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());

  return label || "Usage";
}

/**
 * The `{feature}` placeholder inside an activity row's tiered composition
 * (e.g. `activity.consume.default.credit` = "{feature} credits used"). Maps
 * the raw ledger `feature` value the backend writes (`chat`, `retrieval`,
 * `retrieval_rerank`, `source_ingestion`, `ingestion.asr`, `artifact.image`,
 * `artifact.video_presentation.{asset,narration,validation}`,
 * `html.visual_qa`, ...) through `activity.featureNames`, falling back to
 * `formatFeatureName`'s raw-enum beautifier for any feature the catalogue
 * doesn't (yet) name.
 *
 * `activity.featureNames`' keys are the literal, sometimes dotted, feature
 * strings the backend writes (e.g. `"ingestion.asr"`) as flat JSON keys —
 * not a nested path (`{ "ingestion": { "asr": ... } }`). A JSON object key
 * is just a string; the dot only becomes a hazard if something reads it
 * through a dotted-path walker (`get(obj, "a.b.c")`-style). This map is only
 * ever read with a single bracket lookup (`featureNames[feature]`, right
 * below), never through one, so the literal key is safe and reads better in
 * the JSON than an escaped `"ingestion__asr"` encoding would.
 */
export function formatActivityFeatureName(feature: string, copy: BillingCopy) {
  const featureNames = copy.activity.featureNames as Record<string, string>;
  return featureNames[feature] ?? formatFeatureName(feature);
}

export function formatBillingStatus(
  value: string | null | undefined,
  copy: BillingCopy,
) {
  if (!value) {
    return copy.common.unknown;
  }

  const subscriptionStatuses = copy.common.subscriptionStatuses as Record<
    string,
    string
  >;
  return subscriptionStatuses[value] ?? formatFeatureName(value);
}

/**
 * The Cycle row's detail caption (where the billing-cycle boundary comes
 * from — `billing_accounts.cycle_source`: `free_account` /
 * `provider_subscription` / `manual`, `packages/db/src/schema/billing.ts`).
 * Maps through `common.cycleSources`, falling back to `formatFeatureName`
 * for any value the catalogue doesn't (yet) cover.
 */
export function formatCycleSource(
  value: string | null | undefined,
  copy: BillingCopy,
) {
  if (!value) {
    return "--";
  }

  const cycleSources = copy.common.cycleSources as Record<string, string>;
  return cycleSources[value] ?? formatFeatureName(value);
}

export function formatBillingInterval(
  value: string | null | undefined,
  copy: BillingCopy,
) {
  if (!value || value === "unknown") {
    return copy.common.intervals.notSet;
  }

  return value === "yearly"
    ? copy.common.intervals.annual
    : copy.common.intervals.monthly;
}

export function formatSeatProviderAction(
  value: string | undefined,
  copy: BillingCopy,
) {
  if (!value) {
    return "--";
  }

  const seatProviderActions = copy.billing.seatProviderActions as Record<
    string,
    string
  >;
  return seatProviderActions[value] ?? formatFeatureName(value);
}

export function getSeatPreviewDirection(preview: SeatPreview | null) {
  if (!preview || preview.seatCount === preview.currentSeatCount) {
    return "none";
  }

  return preview.seatCount > preview.currentSeatCount
    ? ("increase" as const)
    : ("decrease" as const);
}

export function formatLedgerChange(
  entry: BillingLedgerEntry,
  format: BillingCopyFormat,
) {
  const prefix = entry.delta > 0 ? "+" : "";
  return `${prefix}${format.number(entry.delta)}`;
}

export function formatLedgerUnit(
  unitType: BillingLedgerEntry["unitType"],
  copy: BillingCopy,
) {
  return copy.common.units[unitType];
}

/**
 * The activity row's "Usage" (Δ) column. Always rendered from the entry's
 * structured fields (`delta`/`balanceAfter`/`unitType`) through the
 * catalogue — never from `entry.activitySummary`, which the server writes
 * as plain English (`formatSignedLedgerDelta`, `formatQuotaRenewalSummary`,
 * plan-name arrows, "150 -> 200 seats", ...) and would leave the column
 * unlocalised for nearly every visible row. Every number goes through
 * `format` (from `useBillingCopy()`), never an ambient/`undefined`-locale
 * `Intl.NumberFormat` — spec O2.
 *
 * Seat rows use a dedicated `usage.ledgerSeatChangeSummary` template
 * (`"{previous} → {next} {unit}"`) instead of the delta/balance phrasing,
 * since a seat count reads more naturally as "3 → 5 seats" than as a delta
 * with a running balance.
 */
export function formatLedgerActivityChange(
  entry: BillingLedgerEntry,
  copy: BillingCopy,
  format: BillingCopyFormat,
) {
  if (entry.unitType === "seat") {
    return formatCopy(copy.usage.ledgerSeatChangeSummary, {
      previous: format.number(entry.balanceAfter - entry.delta),
      next: format.number(entry.balanceAfter),
      unit: formatLedgerUnit(entry.unitType, copy),
    });
  }

  return formatCopy(copy.usage.ledgerChangeSummary, {
    delta: formatLedgerChange(entry, format),
    unit: formatLedgerUnit(entry.unitType, copy),
    balance: format.number(Math.max(entry.balanceAfter, 0)),
  });
}

export function getUsageActivityKind(
  entry: BillingLedgerEntry,
): UsageActivityKind {
  const feature = entry.feature.toLowerCase();
  const modelKind = entry.metadata.modelKind;

  if (modelKind === "image" || feature.includes("image")) {
    return "image";
  }

  if (modelKind === "vision" || feature.includes("vision")) {
    return "vision";
  }

  if (modelKind === "video" || feature.includes("video")) {
    return "video";
  }

  if (modelKind === "chat" || feature.includes("chat")) {
    return "chat";
  }

  return "other";
}

export function formatUsageActivityDetail(
  kind: UsageActivityKind,
  detail: string,
  copy: BillingCopy,
) {
  return formatCopy(copy.usage.activityKindDetail, {
    kind: copy.usage.kinds[kind],
    detail,
  });
}

function isPlainCopyRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads `node[unitType]` when `node` is a plain object, else `undefined`. */
function readUnitTemplate(
  node: unknown,
  unitType: BillingLedgerEntry["unitType"],
): string | undefined {
  if (!isPlainCopyRecord(node)) {
    return undefined;
  }

  const value = node[unitType];
  return typeof value === "string" ? value : undefined;
}

/**
 * Localised activity-row detail text. See `formatLedgerDetail`'s docstring
 * for the four-tier lookup order this implements.
 */
export function formatLedgerDetail(
  entry: BillingLedgerEntry,
  copy: BillingCopy,
): string {
  // Tier 1: an exact `activity.<eventType>.<feature>.<unitType>` entry —
  // covers every known feature, including `consume.ingestion.page`. Always
  // wins over a stored `activityTitle`, so old rows for known features
  // localise too (Review Focus 3).
  const activity = copy.activity as unknown as Record<string, unknown>;
  const eventNode = activity[entry.eventType];
  const featureNode = isPlainCopyRecord(eventNode)
    ? eventNode[entry.feature]
    : undefined;
  const specific = readUnitTemplate(featureNode, entry.unitType);
  if (specific) {
    return specific;
  }

  // Tier 2: `activity.<eventType>.default`, `{feature}`-templated. Covers
  // every other feature under a known event type, including open-ended
  // model-usage `consume` rows (chat, retrieval, ...) — `consume.default`
  // is unit-specific (`credit`/`page`) so the credits-vs-pages distinction
  // the previous English composition made isn't lost.
  const defaultNode = isPlainCopyRecord(eventNode)
    ? eventNode.default
    : undefined;
  const defaultTemplate =
    typeof defaultNode === "string"
      ? defaultNode
      : readUnitTemplate(defaultNode, entry.unitType);
  if (defaultTemplate) {
    return formatCopy(defaultTemplate, {
      feature: formatActivityFeatureName(entry.feature, copy),
    });
  }

  // Tier 3: the English title stored on the row at write time. In
  // practice this is only reached for a feature/event-type combination the
  // catalogue doesn't cover at all (every real `LedgerEventType` ships a
  // `default`, so this tier is a defensive fallback for a malformed/partial
  // `copy`, not a normal code path).
  if (entry.activityTitle) {
    return entry.activityTitle;
  }

  // Tier 4: a generic, still-localised composition — the last resort when
  // even the stored title is empty.
  return formatUsageActivityDetail(
    getUsageActivityKind(entry),
    formatActivityFeatureName(entry.feature, copy),
    copy,
  );
}

export function isLedgerEntryInCycle(
  entry: BillingLedgerEntry,
  summary: BillingSummary,
) {
  const createdAtMs = Date.parse(entry.createdAt);
  return (
    createdAtMs >= Date.parse(summary.cycleStartAt) &&
    createdAtMs < Date.parse(summary.cycleEndAt)
  );
}
