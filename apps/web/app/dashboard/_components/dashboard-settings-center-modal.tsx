"use client";

import * as React from "react";
import {
  Check,
  ChevronDown,
  CreditCard,
  LayoutGrid,
  MailPlus,
  Minus,
  Plus,
  Receipt,
  Trash2,
  User,
  Users,
  X,
} from "lucide-react";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@sourceweft/ui-web/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@sourceweft/ui-web/components/ui/popover";
import { Progress } from "@sourceweft/ui-web/components/ui/progress";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { toast } from "sonner";
import { authClient } from "../../../lib/auth-client";
import { billingCheckoutEnabled } from "../../../lib/deployment-config";
import {
  trackBeginCheckout,
  trackBillingPortalOpened,
  trackCheckoutError,
} from "../../../lib/analytics-events";
import { billingClient } from "../../../lib/sdk";
import { useTheme } from "next-themes";
import { TeamCheckoutDialog } from "../../_components/team-checkout-dialog";
import { getPricingConfig } from "../../_landing/pricing-config";
import {
  getPersonalOrganization,
  getVisibleTeamOrganizations,
  isPersonalOrganization,
} from "./dashboard-team-selector-shared";

export type SettingsCenterTab = "account" | "team" | "usage" | "billing";
type BillingScope = "personal" | "team";
type BillingInterval = "monthly" | "yearly";
type BillingSummary = Awaited<ReturnType<typeof billingClient.getSummary>>;
type BillingSubscription = Awaited<
  ReturnType<typeof billingClient.getSubscription>
>;
type BillingLedger = Awaited<ReturnType<typeof billingClient.getActivity>>;
type BillingLedgerEntry = BillingLedger["items"][number];
type SeatPreview = Awaited<
  ReturnType<typeof billingClient.previewSubscriptionSeats>
>;
type BillingOrg = {
  id: string;
  metadata?: unknown;
  name: string;
  slug?: string;
};
type UsageActivityFilter = "all" | BillingLedgerEntry["unitType"];
type UsageActivityRow = {
  key: string;
  detail: string;
  date: string;
  change: string;
  unitType: UsageActivityFilter;
};
type UsageActivityKind = "image" | "vision" | "chat" | "video" | "other";

const USAGE_ACTIVITY_PAGE_SIZE = 20;
const ACTIVE_SUBSCRIPTION_STATUSES = new Set(["active", "past_due"]);
const usageActivityFilters = [
  { label: "All", value: "all" },
  { label: "Seats", value: "seat" },
  { label: "Pages", value: "page" },
  { label: "Credits", value: "credit" },
] as const satisfies Array<{
  label: string;
  value: UsageActivityFilter;
}>;

const menuItems: Array<{
  key: SettingsCenterTab;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { key: "account", label: "Profile", icon: User },
  { key: "team", label: "Team", icon: Users },
  { key: "usage", label: "Usage", icon: LayoutGrid },
  { key: "billing", label: "Billing", icon: Receipt },
];

// ── Shared primitives ─────────────────────────────────────────────────────────

function OrgSwitcher({ className }: { className?: string }) {
  const { data: orgs } = authClient.useListOrganizations();
  const { data: activeOrg } = authClient.useActiveOrganization();
  const [open, setOpen] = React.useState(false);
  const activeOrgRecord = activeOrg as BillingOrg | null | undefined;

  const orgList = getVisibleTeamOrganizations(
    (orgs ?? []) as Array<{
      id: string;
      metadata?: unknown;
      name: string;
      slug: string;
    }>,
  );
  const personalOrg = getPersonalOrganization((orgs ?? []) as BillingOrg[]);
  const isPersonalActive =
    !activeOrgRecord || isPersonalOrganization(activeOrgRecord);

  async function handleSwitch(orgId: string) {
    try {
      await authClient.organization.setActive({ organizationId: orgId });
      setOpen(false);
    } catch {
      toast.error("Failed to switch team.");
    }
  }

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <button
          className={cn(
            "flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-1.5 text-left transition-colors hover:bg-accent/50 focus-visible:bg-accent/50 aria-expanded:bg-accent/50",
            className,
          )}
          type="button"
        >
          <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-muted text-[10px] font-semibold text-foreground">
            {isPersonalActive
              ? "P"
              : (activeOrgRecord?.name.slice(0, 2).toUpperCase() ?? "P")}
          </div>
          <span className="truncate text-sm text-foreground">
            {isPersonalActive
              ? (personalOrg?.name ?? activeOrgRecord?.name)
              : activeOrgRecord?.name}
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[220px] p-1.5">
        {personalOrg ? (
          <button
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-accent",
              isPersonalActive && "bg-accent/60",
            )}
            onClick={() => void handleSwitch(personalOrg.id)}
            type="button"
          >
            <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-muted text-[10px] font-semibold">
              P
            </div>
            <span className="flex-1 truncate">{personalOrg.name}</span>
            {isPersonalActive && (
              <Check className="h-3.5 w-3.5 shrink-0 text-foreground" />
            )}
          </button>
        ) : null}
        {orgList.length > 0 && (
          <>
            <div className="my-1 border-t border-border/60" />
            {orgList.map((org) => (
              <button
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-accent",
                  activeOrgRecord?.id === org.id && "bg-accent/60",
                )}
                key={org.id}
                onClick={() => void handleSwitch(org.id)}
                type="button"
              >
                <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-muted text-[10px] font-semibold">
                  {org.name.slice(0, 2).toUpperCase()}
                </div>
                <span className="flex-1 truncate">{org.name}</span>
                {activeOrgRecord?.id === org.id && (
                  <Check className="h-3.5 w-3.5 shrink-0 text-foreground" />
                )}
              </button>
            ))}
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

function resolveBillingTeamId(input: {
  activeOrg?: BillingOrg | null;
  orgs?: BillingOrg[] | null;
}) {
  if (input.activeOrg?.id) {
    return input.activeOrg.id;
  }

  const personalOrg = input.orgs?.find(isPersonalOrganization);
  return personalOrg?.id ?? null;
}

function isPersonalBillingOrg(org?: BillingOrg | null) {
  return !org || Boolean(isPersonalOrganization(org));
}

function createBillingReferenceKey(
  scope: BillingScope,
  interval: BillingInterval,
) {
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `settings-billing:${scope}:${interval}:${id}`;
}

function isNonFreePlanFamily(planFamily: string | null | undefined) {
  return Boolean(planFamily && planFamily !== "individual_free");
}

function openBillingPortalWindow(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
}

function useBillingPlanAction(input: {
  billingPeriod: BillingInterval;
  isPersonal: boolean;
  summary: BillingSummary | null;
  subscription: BillingSubscription | null;
  teamId: string | null;
  teamSeatCount?: number;
}) {
  const [actionLoading, setActionLoading] = React.useState(false);
  const subscriptionStatus = input.subscription?.status ?? "inactive";
  const isSubscriptionActive =
    ACTIVE_SUBSCRIPTION_STATUSES.has(subscriptionStatus);
  const shouldManageBilling = input.summary
    ? isNonFreePlanFamily(input.summary.planFamily)
    : Boolean(input.subscription?.externalSubscriptionId);
  const actionLabel = shouldManageBilling ? "Manage billing" : "Upgrade plan";
  const actionDisabled =
    actionLoading ||
    (shouldManageBilling ? !input.teamId : !input.isPersonal && !input.teamId);

  const handleAction = React.useCallback(async () => {
    if (!billingCheckoutEnabled) {
      return;
    }

    if (shouldManageBilling) {
      if (!input.teamId) {
        return;
      }

      setActionLoading(true);
      try {
        const result = await billingClient.createBillingPortal(input.teamId);

        if (result.portalUrl) {
          trackBillingPortalOpened({
            scope: input.isPersonal ? "personal" : "team",
            source: "settings",
          });
          openBillingPortalWindow(result.portalUrl);
          return;
        }

        toast.error("Billing portal is not available.");
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Unable to open billing portal.",
        );
      } finally {
        setActionLoading(false);
      }
      return;
    }

    if (!input.isPersonal && !input.teamId) {
      return;
    }

    setActionLoading(true);
    try {
      if (input.isPersonal) {
        const result = await billingClient.createPricingCheckout({
          plan: "pro",
          billingInterval: input.billingPeriod,
          source: "dashboard",
          clientReferenceKey: createBillingReferenceKey(
            "personal",
            input.billingPeriod,
          ),
        });
        trackBeginCheckout({
          billingInterval: input.billingPeriod,
          plan: "pro",
          source: "settings",
        });
        window.location.assign(result.checkoutUrl);
        return;
      }

      if (!input.teamId) {
        return;
      }

      const result = await billingClient.createSubscriptionCheckout(
        input.teamId,
        {
          planFamily: "team_standard",
          billingInterval: input.billingPeriod,
          seatCount: Math.max(
            input.teamSeatCount ?? 2,
            input.summary?.seats.used ?? 2,
            2,
          ),
        },
      );
      trackBeginCheckout({
        billingInterval: input.billingPeriod,
        plan: "team",
        seatCount: Math.max(
          input.teamSeatCount ?? 2,
          input.summary?.seats.used ?? 2,
          2,
        ),
        source: "settings",
      });
      window.location.assign(result.checkoutUrl);
    } catch (err) {
      trackCheckoutError({
        billingInterval: input.billingPeriod,
        plan: input.isPersonal ? "pro" : "team",
        source: "settings",
      });
      toast.error(
        err instanceof Error ? err.message : "Unable to start checkout.",
      );
    } finally {
      setActionLoading(false);
    }
  }, [
    input.billingPeriod,
    input.isPersonal,
    input.summary?.seats.used,
    input.teamId,
    input.teamSeatCount,
    shouldManageBilling,
  ]);

  return {
    actionDisabled,
    actionLabel,
    actionLoading,
    handleAction,
    isSubscriptionActive,
    shouldManageBilling,
  };
}

function BillingPlanActionControls({
  action,
  billingPeriod,
  onBillingPeriodChange,
  showBillingPeriod = true,
}: {
  action: ReturnType<typeof useBillingPlanAction>;
  billingPeriod: BillingInterval;
  onBillingPeriodChange: (value: BillingInterval) => void;
  showBillingPeriod?: boolean;
}) {
  if (!billingCheckoutEnabled) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {showBillingPeriod && !action.shouldManageBilling ? (
        <div
          aria-label="Billing period"
          className="flex rounded-lg border border-border bg-muted/40 p-0.5"
          role="group"
        >
          {(["monthly", "yearly"] as const).map((period) => (
            <button
              aria-pressed={billingPeriod === period}
              className={cn(
                "min-w-16 rounded-md px-2.5 py-1 text-xs transition-colors",
                billingPeriod === period
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
              key={period}
              onClick={() => onBillingPeriodChange(period)}
              type="button"
            >
              {period === "monthly" ? "Monthly" : "Yearly"}
            </button>
          ))}
        </div>
      ) : null}
      <Button
        disabled={action.actionDisabled}
        onClick={() => void action.handleAction()}
        size="sm"
        type="button"
        variant="outline"
      >
        {action.actionLoading ? "Opening..." : action.actionLabel}
      </Button>
    </div>
  );
}

function formatNumber(value: number) {
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 0,
  }).format(value);
}

function formatCurrencyCents(value: number, currency = "USD") {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(value / 100);
}

function formatPercent(value: number) {
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 1,
    style: "percent",
  }).format(value);
}

function formatPlanName(planFamily: string, personal: boolean) {
  const labelByPlan: Record<string, string> = {
    individual_free: "Free",
    individual_pro: "Pro",
    team_standard: "Team",
    team_premium: "Team Premium",
    enterprise_usage: "Enterprise",
  };

  return labelByPlan[planFamily] ?? (personal ? "Personal" : "Team");
}

function formatFeatureName(feature: string) {
  const label = feature
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());

  return label || "Usage";
}

function formatUsageDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatBillingDate(value: string | null | undefined) {
  if (!value) {
    return "--";
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    year: "numeric",
  }).format(new Date(value));
}

function formatBillingStatus(value: string | null | undefined) {
  if (!value) {
    return "Unknown";
  }

  return formatFeatureName(value);
}

function formatBillingInterval(value: string | null | undefined) {
  if (!value || value === "unknown") {
    return "Not set";
  }

  return value === "yearly" ? "Annual" : "Monthly";
}

function formatSeatProviderAction(value: string | undefined) {
  const labelByAction: Record<string, string> = {
    internal_partial_credit: "Internal partial credit",
    none: "No provider adjustment",
    proration_charge_immediately: "Immediate prorated charge",
    proration_credit: "Provider proration credit",
  };

  return value ? (labelByAction[value] ?? formatFeatureName(value)) : "--";
}

function getSeatPreviewDirection(preview: SeatPreview | null) {
  if (!preview || preview.seatCount === preview.currentSeatCount) {
    return "none";
  }

  return preview.seatCount > preview.currentSeatCount
    ? ("increase" as const)
    : ("decrease" as const);
}

function formatLedgerChange(entry: BillingLedgerEntry) {
  const prefix = entry.delta > 0 ? "+" : "";
  return `${prefix}${formatNumber(entry.delta)}`;
}

function formatLedgerUnit(unitType: BillingLedgerEntry["unitType"]) {
  if (unitType === "seat") {
    return "seats";
  }

  return unitType === "page" ? "pages" : "credits";
}

function formatLedgerActivityChange(entry: BillingLedgerEntry) {
  if (entry.activitySummary) {
    return entry.activitySummary;
  }

  return `${formatLedgerChange(entry)} ${formatLedgerUnit(
    entry.unitType,
  )} · ${formatNumber(Math.max(entry.balanceAfter, 0))} left`;
}

function getUsageActivityKind(entry: BillingLedgerEntry): UsageActivityKind {
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

function formatUsageActivityDetail(kind: UsageActivityKind, detail: string) {
  return `${kind} · ${detail}`;
}

function formatLedgerDetail(entry: BillingLedgerEntry) {
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

function isLedgerEntryInCycle(
  entry: BillingLedgerEntry,
  summary: BillingSummary,
) {
  const createdAtMs = Date.parse(entry.createdAt);
  return (
    createdAtMs >= Date.parse(summary.cycleStartAt) &&
    createdAtMs < Date.parse(summary.cycleEndAt)
  );
}

// ── Account / Profile panel ───────────────────────────────────────────────────

export function AccountPanel({
  userName,
  userEmail,
  userImage,
  initials,
}: {
  userName?: string;
  userEmail?: string;
  userImage?: string | null;
  initials: string;
}) {
  const [displayName, setDisplayName] = React.useState(userName ?? "");
  const [avatarPreview, setAvatarPreview] = React.useState<string | null>(
    userImage ?? null,
  );
  const [avatarDirty, setAvatarDirty] = React.useState(false);
  const [nameError, setNameError] = React.useState<string | null>(null);
  const [isSaving, setIsSaving] = React.useState(false);
  const [isDeleting, setIsDeleting] = React.useState(false);
  const [isSigningOut, setIsSigningOut] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const { theme, setTheme } = useTheme();

  React.useEffect(() => {
    setDisplayName(userName ?? "");
  }, [userName]);
  React.useEffect(() => {
    setAvatarPreview(userImage ?? null);
    setAvatarDirty(false);
  }, [userImage]);

  const trimmed = displayName.trim();
  const isDirty = trimmed !== (userName ?? "") || avatarDirty;

  async function handleSave() {
    if (!trimmed) {
      setNameError("Name is required.");
      return;
    }
    setNameError(null);
    setIsSaving(true);
    try {
      const result = await authClient.updateUser({
        name: trimmed,
        image: avatarPreview ?? undefined,
      });
      if ((result as { error?: { message?: string } } | null)?.error) {
        throw new Error(
          (result as { error?: { message?: string } }).error?.message ??
            "Unable to save.",
        );
      }
      setAvatarDirty(false);
      toast.success("Profile saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unable to save.");
    } finally {
      setIsSaving(false);
    }
  }

  function handleAvatarFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setAvatarPreview(
        typeof reader.result === "string" ? reader.result : null,
      );
      setAvatarDirty(true);
    };
    reader.readAsDataURL(file);
  }

  async function handleDeleteAccount() {
    setIsDeleting(true);
    try {
      const result = await authClient.deleteUser();
      if ((result as { error?: { message?: string } } | null)?.error) {
        throw new Error(
          (result as { error?: { message?: string } }).error?.message ??
            "Unable to delete account.",
        );
      }
      toast.success("Account deletion started");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Unable to delete account.",
      );
    } finally {
      setIsDeleting(false);
    }
  }

  async function handleSignOut() {
    setIsSigningOut(true);
    try {
      await authClient.signOut();
    } finally {
      setIsSigningOut(false);
    }
  }

  return (
    <div className="w-full max-w-2xl divide-y divide-border/60">
      {/* ── Profile ── */}
      <div className="pb-7 pt-1">
        <p className="mb-5 text-base font-semibold text-foreground">Profile</p>
        <div className="flex gap-5">
          {/* Avatar */}
          <div className="shrink-0">
            <input
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="hidden"
              onChange={handleAvatarFile}
              ref={fileInputRef}
              type="file"
            />
            <button
              className="group relative h-14 w-14 overflow-hidden rounded-full border border-border bg-muted text-sm font-semibold text-foreground"
              onClick={() => fileInputRef.current?.click()}
              title="Change avatar"
              type="button"
            >
              {avatarPreview ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  alt="Avatar"
                  className="h-full w-full object-cover"
                  src={avatarPreview}
                />
              ) : (
                <span className="flex h-full w-full items-center justify-center">
                  {initials}
                </span>
              )}
              <span className="absolute inset-0 flex items-center justify-center bg-black/50 text-[10px] font-medium text-white opacity-0 transition-opacity group-hover:opacity-100">
                Change
              </span>
            </button>
          </div>

          {/* Name field */}
          <div className="flex-1">
            <label
              className="mb-1.5 block text-xs font-medium text-muted-foreground"
              htmlFor="display-name"
            >
              Display name
            </label>
            <input
              className={cn(
                "h-9 w-full rounded-lg border bg-background px-3 text-sm text-foreground outline-none transition focus-visible:ring-2 focus-visible:ring-ring",
                nameError ? "border-destructive" : "border-border",
              )}
              id="display-name"
              onChange={(e) => {
                setDisplayName(e.target.value);
                if (nameError) setNameError(null);
              }}
              placeholder="Your display name"
              type="text"
              value={displayName}
            />
            {nameError ? (
              <p className="mt-1 text-xs text-destructive">{nameError}</p>
            ) : null}
            {isDirty && (
              <div className="mt-3 flex items-center gap-2">
                <Button
                  disabled={isSaving}
                  onClick={() => void handleSave()}
                  size="sm"
                  type="button"
                >
                  {isSaving ? "Saving…" : "Save changes"}
                </Button>
                <Button
                  disabled={isSaving}
                  onClick={() => {
                    setDisplayName(userName ?? "");
                    setAvatarPreview(userImage ?? null);
                    setAvatarDirty(false);
                    setNameError(null);
                  }}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Cancel
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Appearance ── */}
      <div className="py-7">
        <p className="mb-4 text-base font-semibold text-foreground">
          Appearance
        </p>
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm text-foreground">Theme</p>
            <p className="text-xs text-muted-foreground">
              Choose how SourceWeft looks to you.
            </p>
          </div>
          <div className="flex rounded-lg border border-border bg-muted/40 p-0.5">
            {(["light", "system", "dark"] as const).map((t) => (
              <button
                className={cn(
                  "rounded-md px-3 py-1 text-xs transition-colors",
                  (theme ?? "system") === t
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
                key={t}
                onClick={() => setTheme(t)}
                type="button"
              >
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Language ── */}
      <div className="py-7">
        <p className="mb-4 text-base font-semibold text-foreground">Language</p>
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm text-foreground">Interface language</p>
            <button
              className="inline-flex h-8 min-w-[130px] cursor-not-allowed items-center justify-between gap-2 rounded-lg border border-border bg-background px-3 text-sm text-foreground opacity-60"
              disabled
              type="button"
            >
              English
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm text-foreground">Response language</p>
              <p className="text-xs text-muted-foreground">Not available yet</p>
            </div>
            <button
              className="inline-flex h-8 min-w-[130px] cursor-not-allowed items-center justify-between gap-2 rounded-lg border border-border bg-background px-3 text-sm text-muted-foreground opacity-40"
              disabled
              type="button"
            >
              Coming soon
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* ── Account ── */}
      <div className="pt-7">
        <p className="mb-4 text-base font-semibold text-foreground">Account</p>
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm text-foreground">{userEmail}</p>
              <p className="text-xs text-muted-foreground">Signed-in account</p>
            </div>
            <Button
              disabled={isSigningOut}
              onClick={() => void handleSignOut()}
              size="sm"
              type="button"
              variant="outline"
            >
              {isSigningOut ? "Signing out…" : "Sign out"}
            </Button>
          </div>
          <div className="flex items-start justify-between gap-4 rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3">
            <div>
              <p className="text-sm font-medium text-destructive">
                Delete account
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Permanently removes your account and all data. Cannot be undone.
              </p>
            </div>
            <Button
              className="shrink-0"
              disabled={isDeleting}
              onClick={() => void handleDeleteAccount()}
              size="sm"
              type="button"
              variant="destructive"
            >
              {isDeleting ? "Deleting…" : "Delete"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Team panel ────────────────────────────────────────────────────────────────

export function TeamPanel({
  onScopeChange,
}: {
  hasTeam: boolean;
  scope: BillingScope;
  onScopeChange: (scope: BillingScope) => void;
  teamName?: string;
}) {
  const { data: orgs, refetch: refetchOrganizations } =
    authClient.useListOrganizations();
  const { data: activeOrg, refetch: refetchActiveOrganization } =
    authClient.useActiveOrganization();
  const [switcherOpen, setSwitcherOpen] = React.useState(false);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [inviteEmail, setInviteEmail] = React.useState("");
  const [inviteRole, setInviteRole] = React.useState<"admin" | "member">(
    "member",
  );
  const [isInviting, setIsInviting] = React.useState(false);
  const [inviteError, setInviteError] = React.useState<string | null>(null);
  const [revokingId, setRevokingId] = React.useState<string | null>(null);
  const [removingMemberId, setRemovingMemberId] = React.useState<string | null>(
    null,
  );

  const refreshTeamData = React.useCallback(async () => {
    await Promise.all([
      refetchActiveOrganization().catch(() => null),
      refetchOrganizations().catch(() => null),
    ]);
  }, [refetchActiveOrganization, refetchOrganizations]);

  React.useEffect(() => {
    void refreshTeamData();
  }, [refreshTeamData]);

  React.useEffect(() => {
    function handleWindowFocus() {
      void refreshTeamData();
    }

    window.addEventListener("focus", handleWindowFocus);
    return () => window.removeEventListener("focus", handleWindowFocus);
  }, [refreshTeamData]);

  React.useEffect(() => {
    const intervalId = window.setInterval(() => void refreshTeamData(), 30000);
    return () => window.clearInterval(intervalId);
  }, [refreshTeamData]);

  async function handleSwitch(org: BillingOrg) {
    try {
      await authClient.organization.setActive({
        organizationId: org.id,
        fetchOptions: { throw: true },
      });
      await refreshTeamData();
      setSwitcherOpen(false);
      onScopeChange(isPersonalOrganization(org) ? "personal" : "team");
    } catch {
      toast.error("Failed to switch team.");
    }
  }

  async function handleInvite() {
    const email = inviteEmail.trim();
    if (!email) return;
    setInviteError(null);
    if (!activeOrgFull || isPersonalOrganization(activeOrgFull)) {
      setInviteError("Personal team cannot invite members.");
      return;
    }
    setIsInviting(true);
    try {
      const result = (await authClient.organization.inviteMember({
        email,
        role: inviteRole,
        organizationId: activeOrgFull.id,
      })) as { error?: { message?: string } } | null;
      if (result?.error)
        throw new Error(result.error.message ?? "Failed to send invite.");
      await refreshTeamData();
      setInviteOpen(false);
      setInviteEmail("");
      setInviteRole("member");
      toast.success(`Invitation sent to ${email}`);
    } catch (err) {
      setInviteError(
        err instanceof Error ? err.message : "Failed to send invitation.",
      );
    } finally {
      setIsInviting(false);
    }
  }

  async function handleRevoke(invitationId: string) {
    setRevokingId(invitationId);
    try {
      const result = (await authClient.organization.cancelInvitation({
        invitationId,
      })) as { error?: { message?: string } } | null;
      if (result?.error)
        throw new Error(result.error.message ?? "Failed to revoke invitation.");
      await refreshTeamData();
      toast.success("Invitation revoked.");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to revoke invitation.",
      );
    } finally {
      setRevokingId(null);
    }
  }

  async function handleRemoveMember(member: {
    id: string;
    role: string;
    user: { email: string; name: string };
  }) {
    setRemovingMemberId(member.id);
    try {
      const result = (await authClient.organization.removeMember({
        memberIdOrEmail: member.id,
        organizationId: activeOrgFull?.id,
      })) as { error?: { message?: string } } | null;
      if (result?.error)
        throw new Error(result.error.message ?? "Failed to remove member.");
      await refreshTeamData();
      toast.success(`${member.user.name || member.user.email} removed.`);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to remove member.",
      );
    } finally {
      setRemovingMemberId(null);
    }
  }

  const orgList = getVisibleTeamOrganizations(
    (orgs ?? []) as Array<{
      id: string;
      metadata?: unknown;
      name: string;
      slug: string;
    }>,
  );
  const personalOrg = getPersonalOrganization((orgs ?? []) as BillingOrg[]);
  const activeOrgFull = activeOrg as
    | {
        id: string;
        metadata?: unknown;
        name: string;
        members: Array<{
          id: string;
          role: string;
          user: { name: string; email: string };
        }>;
        invitations: Array<{
          id: string;
          email: string;
          role: string;
          status: string;
        }>;
      }
    | null
    | undefined;
  const isPersonalActive =
    !activeOrgFull || isPersonalOrganization(activeOrgFull);
  const canManageMembers = Boolean(activeOrgFull && !isPersonalActive);
  const manageableOrg = canManageMembers ? activeOrgFull : null;

  const memberEmails = new Set(
    manageableOrg?.members
      ?.map((member) => member.user.email.toLowerCase())
      .filter(Boolean) ?? [],
  );
  const pendingInvites = manageableOrg
    ? (manageableOrg.invitations?.filter(
        (inv) =>
          inv.status === "pending" &&
          !memberEmails.has(inv.email.toLowerCase()),
      ) ?? [])
    : [];
  const teamPlan = getPricingConfig().find((plan) => plan.id === "team");
  const monthlyTeamSeatPrice = teamPlan?.monthlyPrice ?? 0;
  const yearlyTeamSeatPrice = teamPlan?.yearlyPrice ?? 0;

  return (
    <div className="w-full max-w-2xl divide-y divide-border/60">
      {/* ── Team ── */}
      <div className="pb-7 pt-1">
        <div className="mb-4 flex items-center justify-between gap-3">
          <p className="text-base font-semibold text-foreground">Team</p>
          <Button
            onClick={() => setCreateOpen(true)}
            size="sm"
            type="button"
            variant="outline"
          >
            <Plus className="h-3.5 w-3.5" />
            Create team
          </Button>
        </div>

        {/* Switcher trigger */}
        <Popover onOpenChange={setSwitcherOpen} open={switcherOpen}>
          <PopoverTrigger asChild>
            <button
              className="flex w-full items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2.5 text-left transition-colors hover:bg-accent/50 focus-visible:bg-accent/50 aria-expanded:bg-accent/50"
              type="button"
            >
              <div className="flex min-w-0 items-center gap-2.5">
                <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-muted text-[11px] font-semibold text-foreground">
                  {isPersonalActive
                    ? "P"
                    : activeOrgFull
                      ? activeOrgFull.name.slice(0, 2).toUpperCase()
                      : "P"}
                </div>
                <span className="truncate text-sm text-foreground">
                  {isPersonalActive
                    ? (personalOrg?.name ?? activeOrgFull?.name)
                    : activeOrgFull?.name}
                </span>
              </div>
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-[260px] p-1.5">
            {personalOrg ? (
              <button
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-accent",
                  isPersonalActive && "bg-accent/60",
                )}
                onClick={() => void handleSwitch(personalOrg)}
                type="button"
              >
                <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-muted text-[10px] font-semibold">
                  P
                </div>
                <span className="flex-1 truncate">{personalOrg.name}</span>
                {isPersonalActive && (
                  <Check className="h-3.5 w-3.5 shrink-0 text-foreground" />
                )}
              </button>
            ) : null}
            {orgList.length > 0 && (
              <>
                <div className="my-1 border-t border-border/60" />
                {orgList.map((org) => (
                  <button
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-accent",
                      activeOrgFull?.id === org.id && "bg-accent/60",
                    )}
                    key={org.id}
                    onClick={() => void handleSwitch(org)}
                    type="button"
                  >
                    <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-muted text-[10px] font-semibold">
                      {org.name.slice(0, 2).toUpperCase()}
                    </div>
                    <span className="flex-1 truncate">{org.name}</span>
                    {activeOrgFull?.id === org.id && (
                      <Check className="h-3.5 w-3.5 shrink-0 text-foreground" />
                    )}
                  </button>
                ))}
              </>
            )}
          </PopoverContent>
        </Popover>
      </div>

      {/* ── Members (only when a team is active) ── */}
      {manageableOrg ? (
        <>
          <div className="py-7">
            <div className="mb-4 flex items-center justify-between gap-3">
              <p className="text-base font-semibold text-foreground">Members</p>
              <Button
                onClick={() => setInviteOpen(true)}
                size="sm"
                type="button"
              >
                <MailPlus className="h-3.5 w-3.5" />
                Invite
              </Button>
            </div>
            <div className="overflow-hidden rounded-lg border border-border">
              {manageableOrg.members?.length ? (
                <table className="w-full text-sm">
                  <thead className="border-b border-border bg-muted/30">
                    <tr>
                      <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">
                        Name
                      </th>
                      <th className="hidden px-4 py-2.5 text-left text-xs font-medium text-muted-foreground sm:table-cell">
                        Email
                      </th>
                      <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">
                        Role
                      </th>
                      <th className="w-10 px-4 py-2.5" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/60">
                    {manageableOrg.members.map((m) => (
                      <tr key={m.id}>
                        <td className="px-4 py-2.5 font-medium text-foreground">
                          {m.user.name}
                        </td>
                        <td className="hidden px-4 py-2.5 text-muted-foreground sm:table-cell">
                          {m.user.email}
                        </td>
                        <td className="px-4 py-2.5 capitalize text-muted-foreground">
                          {m.role}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <Button
                            disabled={
                              removingMemberId === m.id ||
                              m.role === "owner" ||
                              manageableOrg.members.length <= 1
                            }
                            onClick={() => void handleRemoveMember(m)}
                            size="xs"
                            title={
                              m.role === "owner"
                                ? "Transfer ownership before removing this member"
                                : "Remove member"
                            }
                            type="button"
                            variant="ghost"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            <span className="sr-only">Remove member</span>
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                  No members yet. Invite someone to get started.
                </div>
              )}
            </div>
          </div>

          {pendingInvites.length > 0 && (
            <div className="py-7">
              <p className="mb-4 text-base font-semibold text-foreground">
                Pending invites
              </p>
              <div className="overflow-hidden rounded-lg border border-border">
                {pendingInvites.map((inv, i) => (
                  <div
                    className={cn(
                      "flex items-center justify-between gap-3 px-4 py-2.5",
                      i !== 0 && "border-t border-border/60",
                    )}
                    key={inv.id}
                  >
                    <div>
                      <p className="text-sm text-foreground">{inv.email}</p>
                      <p className="mt-0.5 text-xs capitalize text-muted-foreground">
                        {inv.role}
                      </p>
                    </div>
                    <Button
                      disabled={revokingId === inv.id}
                      onClick={() => void handleRevoke(inv.id)}
                      size="xs"
                      type="button"
                      variant="ghost"
                    >
                      {revokingId === inv.id ? "Revoking…" : "Revoke"}
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      ) : (
        /* No team selected */
        <div className="py-7">
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-5 py-10 text-center">
            <Users className="h-7 w-7 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">
              Personal team does not support members or invites. Create or
              switch to a team to collaborate.
            </p>
            <Button
              onClick={() => setCreateOpen(true)}
              size="sm"
              type="button"
              variant="outline"
            >
              <Plus className="h-3.5 w-3.5" />
              Create team
            </Button>
          </div>
        </div>
      )}
      <TeamCheckoutDialog
        allowBillingIntervalSwitch
        billingInterval="yearly"
        monthlyPerSeatPrice={monthlyTeamSeatPrice}
        onOpenChange={setCreateOpen}
        open={createOpen}
        perSeatPrice={yearlyTeamSeatPrice}
        referencePrefix="settings-team"
        source="dashboard"
        yearlyPerSeatPrice={yearlyTeamSeatPrice}
      />

      {/* ── Invite dialog ── */}
      <Dialog onOpenChange={setInviteOpen} open={inviteOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Invite team member</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 px-0.5">
            <div>
              <label
                className="mb-1.5 block text-xs font-medium text-muted-foreground"
                htmlFor="invite-email"
              >
                Email address
              </label>
              <input
                autoFocus
                className={cn(
                  "h-9 w-full rounded-lg border bg-background px-3 text-sm text-foreground outline-none transition focus-visible:ring-2 focus-visible:ring-ring",
                  inviteError ? "border-destructive" : "border-border",
                )}
                id="invite-email"
                onChange={(e) => {
                  setInviteEmail(e.target.value);
                  if (inviteError) setInviteError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleInvite();
                }}
                placeholder="colleague@company.com"
                type="email"
                value={inviteEmail}
              />
              {inviteError ? (
                <p className="mt-1 text-xs text-destructive">{inviteError}</p>
              ) : null}
            </div>
            <div>
              <label
                className="mb-1.5 block text-xs font-medium text-muted-foreground"
                htmlFor="invite-role"
              >
                Role
              </label>
              <div className="flex rounded-lg border border-border bg-muted/40 p-0.5">
                {(["member", "admin"] as const).map((r) => (
                  <button
                    className={cn(
                      "flex-1 rounded-md py-1 text-xs transition-colors capitalize",
                      inviteRole === r
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                    key={r}
                    onClick={() => setInviteRole(r)}
                    type="button"
                  >
                    {r}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              type="button"
              onClick={() => setInviteOpen(false)}
            >
              Cancel
            </Button>
            <Button
              disabled={isInviting || !inviteEmail.trim()}
              onClick={() => void handleInvite()}
              size="sm"
              type="button"
            >
              {isInviting ? "Sending…" : "Send invite"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Usage panel ───────────────────────────────────────────────────────────────

export function UsagePanel() {
  const { data: orgs } = authClient.useListOrganizations();
  const { data: activeOrg } = authClient.useActiveOrganization();
  const activeOrgRecord = activeOrg as BillingOrg | null | undefined;
  const orgList = (orgs ?? []) as BillingOrg[];
  const resolvingPersonalTeamId = !activeOrgRecord && orgs === undefined;
  const teamId = resolveBillingTeamId({
    activeOrg: activeOrgRecord,
    orgs: orgList,
  });
  const isPersonal = isPersonalBillingOrg(activeOrgRecord);
  const [summary, setSummary] = React.useState<BillingSummary | null>(null);
  const [subscription, setSubscription] =
    React.useState<BillingSubscription | null>(null);
  const [ledger, setLedger] = React.useState<BillingLedgerEntry[]>([]);
  const [activityCursor, setActivityCursor] = React.useState<string | null>(
    null,
  );
  const [loading, setLoading] = React.useState(false);
  const [loadingMoreActivity, setLoadingMoreActivity] = React.useState(false);
  const [billingPeriod, setBillingPeriod] =
    React.useState<BillingInterval>("yearly");
  const [error, setError] = React.useState<string | null>(null);
  const [activityFilter, setActivityFilter] =
    React.useState<UsageActivityFilter>("all");
  const [activityVisibleCount, setActivityVisibleCount] = React.useState(
    USAGE_ACTIVITY_PAGE_SIZE,
  );

  React.useEffect(() => {
    let cancelled = false;

    async function loadUsage() {
      if (!teamId) {
        setSummary(null);
        setSubscription(null);
        setLedger([]);
        setActivityCursor(null);
        setLoading(resolvingPersonalTeamId);
        setError(null);
        return;
      }

      setLoading(true);
      setError(null);

      try {
        const [nextSummary, nextSubscription, nextLedger] = await Promise.all([
          billingClient.getSummary(teamId),
          billingClient.getSubscription(teamId),
          billingClient.getActivity(teamId, {
            limit: USAGE_ACTIVITY_PAGE_SIZE,
          }),
        ]);

        if (cancelled) {
          return;
        }

        setSummary(nextSummary);
        setSubscription(nextSubscription);
        setLedger(nextLedger.items);
        setActivityCursor(nextLedger.nextCursor ?? null);
      } catch (err) {
        if (cancelled) {
          return;
        }

        setSummary(null);
        setSubscription(null);
        setLedger([]);
        setActivityCursor(null);
        setError(err instanceof Error ? err.message : "Failed to load usage");
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void loadUsage();

    return () => {
      cancelled = true;
    };
  }, [resolvingPersonalTeamId, teamId]);

  React.useEffect(() => {
    setActivityVisibleCount(USAGE_ACTIVITY_PAGE_SIZE);
  }, [activityFilter, teamId]);

  const loadMoreActivity = React.useCallback(async () => {
    if (!teamId || !activityCursor || loadingMoreActivity) {
      return;
    }

    setLoadingMoreActivity(true);
    setError(null);
    try {
      const nextLedger = await billingClient.getActivity(teamId, {
        cursor: activityCursor,
        limit: USAGE_ACTIVITY_PAGE_SIZE,
      });
      setLedger((current) => {
        const mergedById = new Map(
          [...current, ...nextLedger.items].map((entry) => [entry.id, entry]),
        );
        return Array.from(mergedById.values());
      });
      setActivityCursor(nextLedger.nextCursor ?? null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load usage activity",
      );
    } finally {
      setLoadingMoreActivity(false);
    }
  }, [activityCursor, loadingMoreActivity, teamId]);

  const creditsUsed = summary?.credits.consumedThisCycle ?? 0;
  const creditsLimit = summary?.credits.monthlyGrant ?? 0;
  const creditsPercent =
    creditsLimit > 0 ? Math.min(100, (creditsUsed / creditsLimit) * 100) : 0;
  const pagesUsed = summary?.pages.consumedThisCycle ?? 0;
  const pagesMonthlyGrant = summary?.pages.monthlyGrant ?? 0;
  const pagesPercent =
    pagesMonthlyGrant > 0
      ? Math.min(100, (pagesUsed / pagesMonthlyGrant) * 100)
      : 0;
  const seatsUsed = summary?.seats.used ?? 0;
  const seatsLimit = summary?.seats.limit ?? 0;
  const seatsPercent =
    seatsLimit > 0 ? Math.min(100, (seatsUsed / seatsLimit) * 100) : 0;
  const cycleLedgerEntries = summary
    ? ledger.filter((entry) => isLedgerEntryInCycle(entry, summary))
    : ledger;
  const filteredLedgerEntries =
    activityFilter === "all"
      ? cycleLedgerEntries
      : cycleLedgerEntries.filter((entry) => entry.unitType === activityFilter);
  const ledgerActivityRows = filteredLedgerEntries
    .slice(0, activityVisibleCount)
    .map<UsageActivityRow>((entry) => ({
      detail: formatLedgerDetail(entry),
      date: formatUsageDate(entry.createdAt),
      change: formatLedgerActivityChange(entry),
      key: entry.id,
      unitType: entry.unitType,
    }));
  const activityRows = ledgerActivityRows;
  const totalActivityRowCount = filteredLedgerEntries.length;
  const hasMoreActivityRows =
    activityRows.length < totalActivityRowCount || Boolean(activityCursor);
  const data = {
    plan: summary
      ? formatPlanName(summary.planFamily, isPersonal)
      : isPersonal
        ? "Personal"
        : "Team",
    creditsLabel: summary
      ? `${formatNumber(creditsUsed)} / ${formatNumber(creditsLimit)} credits`
      : loading
        ? "Loading credits..."
        : "-- / -- credits",
    creditsPercent,
    pagesLabel: summary
      ? `${formatNumber(pagesUsed)} used · ${formatNumber(
          summary.pages.available,
        )} left`
      : loading
        ? "Loading pages..."
        : "-- used · -- left",
    pagesPercent,
    pagesWallet: summary
      ? `Monthly ${formatNumber(
          summary.pages.monthlyBalance,
        )} · Add-on ${formatNumber(summary.pages.addOnBalance)}`
      : loading
        ? "Monthly ... · Add-on ..."
        : "Monthly -- · Add-on --",
    seatsLabel: summary
      ? `${formatNumber(seatsUsed)} / ${formatNumber(seatsLimit)} seats`
      : loading
        ? "Loading seats..."
        : "-- / -- seats",
    seatsUsage: summary
      ? `${formatNumber(seatsUsed)} used · ${formatNumber(
          summary.seats.remaining,
        )} left`
      : loading
        ? "Loading seats..."
        : "-- used · -- left",
  };
  const emptyActivityLabel = loading
    ? "Loading activity..."
    : teamId
      ? activityFilter === "all"
        ? "No usage activity yet"
        : `No ${formatLedgerUnit(activityFilter)} activity yet`
      : "Usage account unavailable";
  const planAction = useBillingPlanAction({
    billingPeriod,
    isPersonal,
    summary,
    subscription,
    teamId,
  });

  return (
    <div className="w-full max-w-2xl divide-y divide-border/60">
      {/* ── Header ── */}
      <div className="flex items-center justify-between gap-3 pb-7 pt-1">
        <p className="text-base font-semibold text-foreground">Usage</p>
        <OrgSwitcher />
      </div>

      {/* ── Plan + credits ── */}
      <div className="py-7">
        <div className="overflow-hidden rounded-lg border border-border">
          <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
            <p className="text-sm font-medium text-foreground">
              {data.plan} plan
            </p>
            <BillingPlanActionControls
              action={planAction}
              billingPeriod={billingPeriod}
              onBillingPeriodChange={setBillingPeriod}
            />
          </div>
          <div className="px-4 py-3">
            <div className="mb-1.5 flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Credits</span>
              <span className="font-medium text-foreground">
                {data.creditsLabel}
              </span>
            </div>
            <Progress className="h-1.5 bg-muted" value={data.creditsPercent} />
          </div>
          <div className="border-t border-border px-4 py-3">
            <div className="mb-1.5 flex items-center justify-between gap-3 text-xs">
              <span className="text-muted-foreground">Pages</span>
              <span className="text-right font-medium text-foreground">
                {data.pagesLabel}
              </span>
            </div>
            <Progress className="h-1.5 bg-muted" value={data.pagesPercent} />
            <p className="mt-1.5 text-xs text-muted-foreground">
              {data.pagesWallet}
            </p>
          </div>
          {!isPersonal && (
            <div className="border-t border-border px-4 py-3">
              <div className="mb-1.5 flex items-center justify-between gap-3 text-xs">
                <span className="text-muted-foreground">Seats</span>
                <span className="text-right font-medium text-foreground">
                  {data.seatsLabel}
                </span>
              </div>
              <Progress className="h-1.5 bg-muted" value={seatsPercent} />
              <p className="mt-1.5 text-xs text-muted-foreground">
                {data.seatsUsage}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* ── Activity ── */}
      <div className="pt-7">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-base font-semibold text-foreground">Activity</p>
          <div
            aria-label="Filter usage activity"
            className="flex rounded-lg border border-border bg-muted/40 p-0.5"
            role="group"
          >
            {usageActivityFilters.map((filter) => (
              <button
                aria-pressed={activityFilter === filter.value}
                className={cn(
                  "min-w-14 rounded-md px-2.5 py-1 text-xs transition-colors",
                  activityFilter === filter.value
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
                key={filter.value}
                onClick={() => {
                  setActivityFilter(filter.value);
                  setActivityVisibleCount(USAGE_ACTIVITY_PAGE_SIZE);
                }}
                type="button"
              >
                {filter.label}
              </button>
            ))}
          </div>
        </div>
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/30">
              <tr>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">
                  Detail
                </th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">
                  Date
                </th>
                <th className="px-4 py-2.5 text-right text-xs font-medium text-muted-foreground">
                  Usage
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {activityRows.length > 0 ? (
                activityRows.map((row) => (
                  <tr key={row.key}>
                    <td className="px-4 py-2.5 text-foreground">
                      {row.detail}
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground">
                      {row.date}
                    </td>
                    <td className="px-4 py-2.5 text-right font-medium text-foreground">
                      {row.change}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td className="px-4 py-2.5 text-foreground">
                    {emptyActivityLabel}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">--</td>
                  <td className="px-4 py-2.5 text-right font-medium text-foreground">
                    --
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {hasMoreActivityRows && (
          <div className="px-4 py-2">
            <Button
              disabled={loadingMoreActivity}
              className="h-auto w-full justify-center px-0 py-1 text-[11px] font-medium text-muted-foreground hover:bg-transparent hover:text-foreground"
              onClick={() => {
                if (activityRows.length < totalActivityRowCount) {
                  setActivityVisibleCount((count) =>
                    Math.min(
                      count + USAGE_ACTIVITY_PAGE_SIZE,
                      totalActivityRowCount,
                    ),
                  );
                  return;
                }
                void loadMoreActivity();
              }}
              size="xs"
              type="button"
              variant="ghost"
            >
              {loadingMoreActivity ? "Loading..." : "Load more"}
            </Button>
          </div>
        )}
        {error && <p className="mt-3 text-xs text-muted-foreground">{error}</p>}
      </div>
    </div>
  );
}
// ── Billing panel ─────────────────────────────────────────────────────────────

export function BillingPanel() {
  const { data: orgs } = authClient.useListOrganizations();
  const { data: activeOrg } = authClient.useActiveOrganization();
  const activeOrgRecord = activeOrg as BillingOrg | null | undefined;
  const orgList = (orgs ?? []) as BillingOrg[];
  const resolvingPersonalTeamId = !activeOrgRecord && orgs === undefined;
  const teamId = resolveBillingTeamId({
    activeOrg: activeOrgRecord,
    orgs: orgList,
  });
  const isPersonal = isPersonalBillingOrg(activeOrgRecord);
  const [summary, setSummary] = React.useState<BillingSummary | null>(null);
  const [subscription, setSubscription] =
    React.useState<BillingSubscription | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [seatActionLoading, setSeatActionLoading] = React.useState(false);
  const [seatPreviewOpen, setSeatPreviewOpen] = React.useState(false);
  const [seatPreview, setSeatPreview] = React.useState<SeatPreview | null>(
    null,
  );
  const [billingPeriod, setBillingPeriod] =
    React.useState<BillingInterval>("yearly");
  const [targetSeatCount, setTargetSeatCount] = React.useState(2);
  const [error, setError] = React.useState<string | null>(null);

  const loadBilling = React.useCallback(
    async (options?: { silent?: boolean }) => {
      if (!teamId) {
        setSummary(null);
        setSubscription(null);
        setLoading(resolvingPersonalTeamId);
        setError(null);
        return;
      }

      if (!options?.silent) {
        setLoading(true);
      }
      setError(null);

      try {
        const [nextSummary, nextSubscription] = await Promise.all([
          billingClient.getSummary(teamId),
          billingClient.getSubscription(teamId),
        ]);

        setSummary(nextSummary);
        setSubscription(nextSubscription);
      } catch (err) {
        setSummary(null);
        setSubscription(null);
        setError(err instanceof Error ? err.message : "Failed to load billing");
      } finally {
        if (!options?.silent) {
          setLoading(false);
        }
      }
    },
    [resolvingPersonalTeamId, teamId],
  );

  React.useEffect(() => {
    let cancelled = false;

    async function load() {
      await loadBilling();
      if (cancelled) {
        setSummary(null);
        setSubscription(null);
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [loadBilling]);

  React.useEffect(() => {
    const minimumSeats = Math.max(summary?.seats.used ?? 2, 2);
    setTargetSeatCount((current) =>
      Math.max(current, summary?.seats.limit ?? minimumSeats, minimumSeats),
    );
  }, [summary?.seats.limit, summary?.seats.used]);

  async function handleUpdateSeats() {
    if (!teamId || isPersonal) {
      return;
    }

    setSeatActionLoading(true);

    try {
      const minimumSeats = Math.max(summary?.seats.used ?? 2, 2);
      const seatCount = Math.max(targetSeatCount, minimumSeats);
      const preview = await billingClient.previewSubscriptionSeats(teamId, {
        seatCount,
      });
      setSeatPreview(preview);
      setSeatPreviewOpen(true);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Unable to update seats.",
      );
    } finally {
      setSeatActionLoading(false);
    }
  }

  async function handleConfirmSeatChange() {
    if (!teamId || !seatPreview) {
      return;
    }

    setSeatActionLoading(true);
    try {
      await billingClient.updateSubscriptionSeats(teamId, {
        seatCount: seatPreview.seatCount,
      });
      toast.success("Seat count updated.");
      setSeatPreviewOpen(false);
      setSeatPreview(null);
      await loadBilling({ silent: true });
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Unable to update seats.",
      );
    } finally {
      setSeatActionLoading(false);
    }
  }

  const planName = summary
    ? formatPlanName(summary.planFamily, isPersonal)
    : isPersonal
      ? "Personal"
      : "Team";
  const activeScopeLabel = isPersonal
    ? "Personal billing"
    : `${activeOrgRecord?.name ?? "Team"} billing`;
  const subscriptionStatus = subscription?.status ?? "inactive";
  const hasPaidSubscription = Boolean(subscription?.externalSubscriptionId);
  const subscriptionStatusLabel = hasPaidSubscription
    ? formatBillingStatus(subscriptionStatus)
    : "No paid subscription";
  const planStateLabel = hasPaidSubscription
    ? subscriptionStatusLabel
    : `${planName} account`;
  const seatsUsed = summary?.seats.used ?? 0;
  const seatsLimit = summary?.seats.limit ?? 0;
  const seatsRemaining = summary?.seats.remaining ?? 0;
  const minimumSeatCount = Math.max(seatsUsed, 2);
  const creditsUsed = summary?.credits.consumedThisCycle ?? 0;
  const creditsLimit = summary?.credits.monthlyGrant ?? 0;
  const pagesUsed = summary?.pages.consumedThisCycle ?? 0;
  const pagesLimit = summary?.pages.monthlyGrant ?? 0;
  const cycleLabel = summary
    ? `${formatBillingDate(summary.cycleStartAt)} - ${formatBillingDate(
        summary.cycleEndAt,
      )}`
    : loading
      ? "Loading cycle..."
      : "--";
  const billingRows = [
    {
      label: "Cycle",
      value: cycleLabel,
      detail: summary ? formatFeatureName(summary.cycleSource) : "--",
    },
    {
      label: "Credits",
      value: summary
        ? `${formatNumber(creditsUsed)} / ${formatNumber(creditsLimit)}`
        : loading
          ? "Loading..."
          : "-- / --",
      detail: summary
        ? `${formatNumber(summary.credits.available)} available`
        : "Credit availability is unavailable",
    },
    {
      label: "Pages",
      value: summary
        ? `${formatNumber(pagesUsed)} / ${formatNumber(pagesLimit)}`
        : loading
          ? "Loading..."
          : "-- / --",
      detail: summary
        ? `${formatNumber(summary.pages.available)} available`
        : "Page availability is unavailable",
    },
  ];
  const planAction = useBillingPlanAction({
    billingPeriod,
    isPersonal,
    summary,
    subscription,
    teamId,
    teamSeatCount: targetSeatCount,
  });
  const { isSubscriptionActive } = planAction;
  const canUpdateSeats =
    !isPersonal &&
    isSubscriptionActive &&
    targetSeatCount >= minimumSeatCount &&
    targetSeatCount !== seatsLimit;
  const seatPreviewQuota = seatPreview?.quotaAdjustment;
  const seatPreviewBilling = seatPreview?.billingAdjustment;
  const seatPreviewDirection = getSeatPreviewDirection(seatPreview);
  const seatPreviewIsIncrease = seatPreviewDirection === "increase";
  const seatPreviewRows =
    seatPreviewDirection === "decrease"
      ? [
          {
            label: "Theoretical refund",
            value: seatPreviewBilling
              ? formatCurrencyCents(
                  seatPreviewBilling.theoreticalRefundCents,
                  seatPreviewBilling.currency,
                )
              : "--",
          },
          {
            label: "Refund or credit",
            value: seatPreviewBilling
              ? formatCurrencyCents(
                  seatPreviewBilling.actualRefundCents,
                  seatPreviewBilling.currency,
                )
              : "--",
          },
          {
            label: "Not refundable",
            value: seatPreviewBilling
              ? formatCurrencyCents(
                  seatPreviewBilling.unrefundedCents,
                  seatPreviewBilling.currency,
                )
              : "--",
          },
          {
            label: "Refund ratio",
            value: seatPreviewQuota
              ? formatPercent(seatPreviewQuota.refundRatio)
              : "--",
          },
          {
            label: "Credits deducted",
            value: seatPreviewQuota
              ? `${formatNumber(seatPreviewQuota.actualCredits)} / ${formatNumber(
                  seatPreviewQuota.targetCredits,
                )}`
              : "--",
          },
          {
            label: "Pages deducted",
            value: seatPreviewQuota
              ? `${formatNumber(seatPreviewQuota.actualPages)} / ${formatNumber(
                  seatPreviewQuota.targetPages,
                )}`
              : "--",
          },
          {
            label: "Billing action",
            value: formatSeatProviderAction(seatPreviewBilling?.providerAction),
          },
        ]
      : [
          {
            label: "Estimated prorated charge",
            value: seatPreviewBilling
              ? formatCurrencyCents(
                  seatPreviewBilling.estimatedChargeCents,
                  seatPreviewBilling.currency,
                )
              : "--",
          },
          {
            label: "Billing action",
            value: formatSeatProviderAction(seatPreviewBilling?.providerAction),
          },
        ];

  return (
    <>
      <div className="w-full max-w-2xl divide-y divide-border/60">
        {/* ── Header ── */}
        <div className="flex items-center justify-between gap-3 pb-7 pt-1">
          <p className="text-base font-semibold text-foreground">Billing</p>
          <OrgSwitcher />
        </div>

        {/* ── Plan ── */}
        <div className="py-7">
          <div className="overflow-hidden rounded-lg border border-border bg-background">
            <div className="flex flex-col gap-4 border-b border-border px-4 py-4 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <div className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
                  <CreditCard className="h-3.5 w-3.5" />
                  {activeScopeLabel}
                </div>
                <p className="mt-3 text-lg font-semibold text-foreground">
                  {planName} plan
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {planStateLabel} ·{" "}
                  {formatBillingInterval(subscription?.billingInterval)}
                </p>
              </div>
              <BillingPlanActionControls
                action={planAction}
                billingPeriod={billingPeriod}
                onBillingPeriodChange={setBillingPeriod}
              />
            </div>
            <div className="grid gap-0 divide-y divide-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
              {billingRows.map((row) => (
                <div className="px-4 py-3" key={row.label}>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    {row.label}
                  </p>
                  <p className="mt-1 text-sm font-medium leading-5 text-foreground">
                    {row.value}
                  </p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {row.detail}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>

        {!isPersonal && (
          <div className="pt-7">
            <div className="mb-4 flex items-center justify-between gap-3">
              <p className="text-base font-semibold text-foreground">Seats</p>
              <Button
                disabled={
                  planAction.actionLoading ||
                  seatActionLoading ||
                  !billingCheckoutEnabled ||
                  !teamId ||
                  (isSubscriptionActive && !canUpdateSeats)
                }
                onClick={() =>
                  void (isSubscriptionActive
                    ? handleUpdateSeats()
                    : planAction.handleAction())
                }
                size="sm"
                type="button"
                variant="outline"
              >
                {isSubscriptionActive ? "Update seats" : "Add seats"}
              </Button>
            </div>
            <div className="rounded-lg border border-border px-4 py-3">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {summary
                      ? `${formatNumber(seatsUsed)} of ${formatNumber(
                          seatsLimit,
                        )} seats used`
                      : loading
                        ? "Loading seats..."
                        : "-- of -- seats used"}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {summary
                      ? `${formatNumber(seatsRemaining)} seats remaining`
                      : "Seat availability is unavailable"}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <input
                    aria-label="Total seats"
                    className="h-9 w-20 rounded-md border border-input bg-background px-2 text-right text-sm font-medium text-foreground outline-none transition-colors focus:border-ring"
                    disabled={!isSubscriptionActive || seatActionLoading}
                    min={minimumSeatCount}
                    onChange={(event) =>
                      setTargetSeatCount(
                        Math.max(
                          minimumSeatCount,
                          Number.parseInt(event.target.value, 10) ||
                            minimumSeatCount,
                        ),
                      )
                    }
                    type="number"
                    value={targetSeatCount}
                  />
                  <span className="text-sm font-medium text-foreground">
                    total
                  </span>
                </div>
              </div>
              {isSubscriptionActive && targetSeatCount < seatsLimit && (
                <p className="mt-3 text-xs text-muted-foreground">
                  Seat reductions require a billing preview before they are
                  applied.
                </p>
              )}
              {isSubscriptionActive && targetSeatCount > seatsLimit && (
                <p className="mt-3 text-xs text-muted-foreground">
                  Seat increases require a billing preview before they are
                  applied.
                </p>
              )}
              {isSubscriptionActive && targetSeatCount === seatsLimit && (
                <p className="mt-3 text-xs text-muted-foreground">
                  Seat count is already synced.
                </p>
              )}
            </div>
          </div>
        )}

        <div className="pt-7">
          <p className="mb-4 text-base font-semibold text-foreground">
            Subscription
          </p>
          <div className="overflow-hidden rounded-lg border border-border">
            {[
              {
                label: "Status",
                value: subscriptionStatusLabel,
              },
              {
                label: "Billing cadence",
                value: formatBillingInterval(subscription?.billingInterval),
              },
              {
                label: "Renewal",
                value: subscription?.cancelAtPeriodEnd
                  ? "Cancels at period end"
                  : isSubscriptionActive
                    ? "Renews automatically"
                    : "Not scheduled",
              },
              {
                label: "Last updated",
                value: subscription?.lastEventAt
                  ? formatBillingDate(subscription.lastEventAt)
                  : "No subscription updates yet",
              },
            ].map((row, index) => (
              <div
                className={cn(
                  "flex items-center justify-between gap-4 px-4 py-3",
                  index !== 0 && "border-t border-border/60",
                )}
                key={row.label}
              >
                <p className="text-sm text-muted-foreground">{row.label}</p>
                <p className="text-right text-sm font-medium text-foreground">
                  {row.value}
                </p>
              </div>
            ))}
          </div>
          {error && (
            <p className="mt-3 text-xs text-muted-foreground">{error}</p>
          )}
        </div>
      </div>
      <Dialog
        onOpenChange={(open) => {
          setSeatPreviewOpen(open);
          if (!open) {
            setSeatPreview(null);
          }
        }}
        open={seatPreviewOpen}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {seatPreviewIsIncrease
                ? "Review seat increase"
                : "Review seat reduction"}
            </DialogTitle>
          </DialogHeader>
          {seatPreview ? (
            <div className="space-y-4">
              <div className="rounded-lg border border-border bg-muted/20 px-4 py-3">
                <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                  {seatPreviewIsIncrease ? (
                    <Plus className="h-3.5 w-3.5" />
                  ) : (
                    <Minus className="h-3.5 w-3.5" />
                  )}
                  {formatNumber(seatPreview.currentSeatCount)} to{" "}
                  {formatNumber(seatPreview.seatCount)} seats
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {formatNumber(seatPreview.seatsUsed)} members and{" "}
                  {formatNumber(seatPreview.pendingInvitations)} pending invites
                  will remain allocated.
                </p>
              </div>
              <div className="overflow-hidden rounded-lg border border-border">
                {seatPreviewRows.map((row, index) => (
                  <div
                    className={cn(
                      "flex items-center justify-between gap-4 px-4 py-2.5",
                      index !== 0 && "border-t border-border/60",
                    )}
                    key={row.label}
                  >
                    <p className="text-sm text-muted-foreground">{row.label}</p>
                    <p className="text-right text-sm font-medium text-foreground">
                      {row.value}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button
              disabled={seatActionLoading}
              onClick={() => setSeatPreviewOpen(false)}
              size="sm"
              type="button"
              variant="ghost"
            >
              Cancel
            </Button>
            <Button
              disabled={seatActionLoading || !seatPreview}
              onClick={() => void handleConfirmSeatChange()}
              size="sm"
              type="button"
            >
              {seatActionLoading
                ? "Updating..."
                : seatPreviewIsIncrease
                  ? "Confirm increase"
                  : "Confirm reduction"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ── Modal shell ───────────────────────────────────────────────────────────────

export function DashboardSettingsCenterModal({
  open,
  onOpenChange,
  userName,
  userEmail,
  userImage,
  initials,
  teamName,
  initialTab,
  hasTeam = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userName?: string;
  userEmail?: string;
  userImage?: string | null;
  initials: string;
  teamName?: string;
  initialTab: SettingsCenterTab;
  hasTeam?: boolean;
}) {
  const [activeTab, setActiveTab] =
    React.useState<SettingsCenterTab>(initialTab);
  const [scope, setScope] = React.useState<BillingScope>(
    hasTeam ? "team" : "personal",
  );
  const wasOpenRef = React.useRef(open);

  React.useEffect(() => {
    if (open && !wasOpenRef.current) {
      setActiveTab(initialTab);
    }
    wasOpenRef.current = open;
  }, [open, initialTab]);

  React.useEffect(() => {
    if (!hasTeam) setScope("personal");
  }, [hasTeam]);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="h-[min(780px,calc(100svh-2rem))] w-[calc(100vw-2rem)] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border/80 bg-background p-0 shadow-2xl sm:w-[min(900px,calc(100vw-2rem))] sm:max-w-[min(900px,calc(100vw-2rem))]"
        constrainWidth={false}
        showCloseButton={false}
      >
        <div className="grid h-full grid-cols-1 sm:grid-cols-[180px_minmax(0,1fr)]">
          {/* ── Sidebar ── */}
          <aside className="flex min-h-0 flex-col border-b border-border/70 bg-muted/30 sm:border-b-0 sm:border-r">
            {/* User identity */}
            <div className="border-b border-border/70 px-4 py-3.5">
              <div className="flex items-center gap-2.5">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
                  {initials}
                </div>
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-medium text-foreground">
                    {userName ?? "SourceWeft User"}
                  </p>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {userEmail}
                  </p>
                </div>
              </div>
            </div>

            {/* Nav */}
            <nav className="flex-1 overflow-y-auto px-2.5 py-2.5">
              <div className="space-y-0.5">
                {menuItems.map((item) => {
                  const Icon = item.icon;
                  const active = activeTab === item.key;
                  return (
                    <button
                      className={cn(
                        "flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors",
                        active
                          ? "bg-background text-foreground shadow-sm"
                          : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
                      )}
                      key={item.key}
                      onClick={() => setActiveTab(item.key)}
                      type="button"
                    >
                      <Icon className="h-3.5 w-3.5 shrink-0" />
                      {item.label}
                    </button>
                  );
                })}
              </div>
            </nav>
          </aside>

          {/* ── Content ── */}
          <div className="relative min-h-0 overflow-hidden">
            {/* Close button */}
            <button
              aria-label="Close"
              className="absolute right-3 top-3 z-10 flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              onClick={() => onOpenChange(false)}
              type="button"
            >
              <X className="h-4 w-4" />
            </button>

            {/* Scrollable area */}
            <div className="absolute inset-0 overflow-y-auto overflow-x-hidden overscroll-contain px-6 pb-10 pt-6 pr-12">
              {activeTab === "account" && (
                <AccountPanel
                  initials={initials}
                  userEmail={userEmail}
                  userImage={userImage}
                  userName={userName}
                />
              )}
              {activeTab === "team" && (
                <TeamPanel
                  hasTeam={hasTeam}
                  onScopeChange={setScope}
                  scope={scope}
                  teamName={teamName}
                />
              )}
              {activeTab === "usage" && <UsagePanel />}
              {activeTab === "billing" && <BillingPanel />}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
