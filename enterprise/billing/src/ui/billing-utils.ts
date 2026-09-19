import { isPersonalOrganization } from "@sourceweft/contracts/organization-metadata";
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
export const usageActivityFilters = [
  { label: "All", value: "all" },
  { label: "Seats", value: "seat" },
  { label: "Pages", value: "page" },
  { label: "Credits", value: "credit" },
] as const satisfies Array<{
  label: string;
  value: UsageActivityFilter;
}>;

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

export function formatLedgerUnit(unitType: BillingLedgerEntry["unitType"]) {
  if (unitType === "seat") {
    return "seats";
  }

  return unitType === "page" ? "pages" : "credits";
}

export function formatLedgerActivityChange(entry: BillingLedgerEntry) {
  if (entry.activitySummary) {
    return entry.activitySummary;
  }

  return `${formatLedgerChange(entry)} ${formatLedgerUnit(
    entry.unitType,
  )} · ${formatNumber(Math.max(entry.balanceAfter, 0))} left`;
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
) {
  return `${kind} · ${detail}`;
}

export function formatLedgerDetail(entry: BillingLedgerEntry) {
  if (entry.activityTitle) {
    return entry.activityTitle;
  }

  const feature = formatFeatureName(entry.feature);
  const kind = getUsageActivityKind(entry);
  const detail = (() => {
    if (entry.eventType === "consume") {
      if (entry.unitType === "page" && entry.feature === "ingestion") {
        return "Pages indexed";
      }

      if (entry.unitType === "credit") {
        return `${feature} credits used`;
      }

      return `${feature} pages used`;
    }

    if (entry.eventType === "grant") {
      if (entry.feature === "cycle_grant") {
        return entry.unitType === "page"
          ? "Monthly pages granted"
          : "Monthly credits granted";
      }

      if (entry.feature === "seat_quota_grant") {
        return entry.unitType === "page"
          ? "Seat pages granted"
          : "Seat credits granted";
      }

      if (entry.feature === "plan_upgrade_grant") {
        return entry.unitType === "page"
          ? "Plan pages granted"
          : "Plan credits granted";
      }

      if (entry.unitType === "page" && entry.feature === "shadow_auto_grant") {
        return "Add-on pages granted";
      }

      return `${feature} granted`;
    }

    if (entry.eventType === "expire") {
      return entry.unitType === "page"
        ? "Monthly pages expired"
        : "Unused credits expired";
    }

    if (entry.eventType === "adjust") {
      if (entry.feature === "seat_quota_change") {
        return "Seats updated";
      }

      return `${feature} adjusted`;
    }

    if (entry.eventType === "refund") {
      return `${feature} refunded`;
    }

    if (entry.eventType === "reserve") {
      return `${feature} reserved`;
    }

    if (entry.eventType === "release") {
      return `${feature} released`;
    }

    return feature;
  })();

  return formatUsageActivityDetail(kind, detail);
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
