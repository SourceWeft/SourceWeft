import { isPersonalOrganization } from "@sourceweft/contracts/organization-metadata";
import { formatCopy, type BillingCopy } from "../messages";
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

export function formatNumber(value: number) {
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 0,
  }).format(value);
}

export function formatCurrencyCents(value: number, currency = "USD") {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(value / 100);
}

export function formatPercent(value: number) {
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 1,
    style: "percent",
  }).format(value);
}

export function formatPlanName(planFamily: string, personal: boolean) {
  const labelByPlan: Record<string, string> = {
    individual_free: "Free",
    individual_pro: "Pro",
    team_standard: "Team",
    team_premium: "Team Premium",
    enterprise_usage: "Enterprise",
  };

  return labelByPlan[planFamily] ?? (personal ? "Personal" : "Team");
}

export function formatFeatureName(feature: string) {
  const label = feature
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());

  return label || "Usage";
}

export function formatUsageDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function formatBillingDate(value: string | null | undefined) {
  if (!value) {
    return "--";
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    year: "numeric",
  }).format(new Date(value));
}

export function formatBillingStatus(value: string | null | undefined) {
  if (!value) {
    return "Unknown";
  }

  return formatFeatureName(value);
}

export function formatBillingInterval(value: string | null | undefined) {
  if (!value || value === "unknown") {
    return "Not set";
  }

  return value === "yearly" ? "Annual" : "Monthly";
}

export function formatSeatProviderAction(value: string | undefined) {
  const labelByAction: Record<string, string> = {
    internal_partial_credit: "Internal partial credit",
    none: "No provider adjustment",
    proration_charge_immediately: "Immediate prorated charge",
    proration_credit: "Provider proration credit",
  };

  return value ? (labelByAction[value] ?? formatFeatureName(value)) : "--";
}

export function getSeatPreviewDirection(preview: SeatPreview | null) {
  if (!preview || preview.seatCount === preview.currentSeatCount) {
    return "none";
  }

  return preview.seatCount > preview.currentSeatCount
    ? ("increase" as const)
    : ("decrease" as const);
}

export function formatLedgerChange(entry: BillingLedgerEntry) {
  const prefix = entry.delta > 0 ? "+" : "";
  return `${prefix}${formatNumber(entry.delta)}`;
}

export function formatLedgerUnit(
  unitType: BillingLedgerEntry["unitType"],
  copy: BillingCopy,
) {
  return copy.common.units[unitType];
}

export function formatLedgerActivityChange(
  entry: BillingLedgerEntry,
  copy: BillingCopy,
) {
  if (entry.activitySummary) {
    return entry.activitySummary;
  }

  return formatCopy(copy.usage.ledgerChangeSummary, {
    delta: formatLedgerChange(entry),
    unit: formatLedgerUnit(entry.unitType, copy),
    balance: formatNumber(Math.max(entry.balanceAfter, 0)),
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
      feature: formatFeatureName(entry.feature),
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
    formatFeatureName(entry.feature),
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
