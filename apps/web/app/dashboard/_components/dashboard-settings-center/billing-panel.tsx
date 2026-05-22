"use client";

import * as React from "react";
import { CreditCard, Minus, Plus } from "lucide-react";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@sourceweft/ui-web/components/ui/dialog";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { toast } from "sonner";
import { authClient } from "../../../../lib/auth-client";
import { billingCheckoutEnabled } from "../../../../lib/deployment-config";
import { billingClient } from "../../../../lib/sdk";
import { BillingPanelSkeleton } from "../dashboard-settings-center-modal-skeleton";
import { BillingPlanActionControls } from "./billing-plan-action-controls";
import {
  formatBillingDate,
  formatBillingInterval,
  formatBillingStatus,
  formatCurrencyCents,
  formatFeatureName,
  formatNumber,
  formatPercent,
  formatPlanName,
  formatSeatProviderAction,
  getSeatPreviewDirection,
  isPersonalBillingOrg,
  resolveBillingTeamId,
} from "./billing-utils";
import { OrgSwitcher } from "./org-switcher";
import type {
  BillingInterval,
  BillingOrg,
  BillingSubscription,
  BillingSummary,
  SeatPreview,
} from "./types";
import { useBillingPlanAction } from "./use-billing-plan-action";

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
  const [loading, setLoading] = React.useState(
    () => Boolean(teamId) || resolvingPersonalTeamId,
  );
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
  const loadingInitialBilling = loading && !summary && !subscription;

  if (loadingInitialBilling) {
    return <BillingPanelSkeleton />;
  }

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
