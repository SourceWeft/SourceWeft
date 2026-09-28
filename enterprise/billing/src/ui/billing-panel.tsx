"use client";
import { useBillingUiHost } from "./context";

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

import { BillingPlanActionControls } from "./billing-plan-action-controls";
import { formatCopy } from "../messages";
import {
  formatBillingInterval,
  formatBillingStatus,
  formatCycleSource,
  formatPlanName,
  formatSeatProviderAction,
  getSeatPreviewDirection,
  isPersonalBillingOrg,
  resolveBillingTeamId,
} from "./billing-utils";
import { useBillingCopy } from "./use-billing-copy";

import type {
  BillingInterval,
  BillingOrg,
  BillingSubscription,
  BillingSummary,
  SeatPreview,
} from "./types";
import { TopupActions } from "./topup-actions";
import { useBillingPlanAction } from "./use-billing-plan-action";

export function BillingPanel() {
  const {
    authClient,
    billingCheckoutEnabled,
    billingClient,
    BillingPanelSkeleton,
    OrgSwitcher,
  } = useBillingUiHost();
  const { copy, format } = useBillingCopy();

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
        setError(
          err instanceof Error ? err.message : copy.billing.failedToLoad,
        );
      } finally {
        if (!options?.silent) {
          setLoading(false);
        }
      }
    },
    [copy, resolvingPersonalTeamId, teamId, billingClient],
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
        err instanceof Error ? err.message : copy.billing.unableToUpdateSeats,
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
      toast.success(copy.billing.seatCountUpdated);
      setSeatPreviewOpen(false);
      setSeatPreview(null);
      await loadBilling({ silent: true });
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : copy.billing.unableToUpdateSeats,
      );
    } finally {
      setSeatActionLoading(false);
    }
  }

  const planName = summary
    ? formatPlanName(summary.planFamily, isPersonal, copy)
    : isPersonal
      ? copy.common.personal
      : copy.common.team;
  const activeScopeLabel = isPersonal
    ? copy.billing.scopePersonal
    : formatCopy(copy.billing.scopeTeam, {
        team: activeOrgRecord?.name ?? copy.common.team,
      });
  const subscriptionStatus = subscription?.status ?? "inactive";
  const hasPaidSubscription = Boolean(subscription?.externalSubscriptionId);
  const subscriptionStatusLabel = hasPaidSubscription
    ? formatBillingStatus(subscriptionStatus, copy)
    : copy.billing.noPaidSubscription;
  const planStateLabel = hasPaidSubscription
    ? subscriptionStatusLabel
    : formatCopy(copy.billing.planAccount, { plan: planName });
  const seatsUsed = summary?.seats.used ?? 0;
  const seatsLimit = summary?.seats.limit ?? 0;
  const seatsRemaining = summary?.seats.remaining ?? 0;
  const minimumSeatCount = Math.max(seatsUsed, 2);
  const creditsUsed = summary?.credits.consumedThisCycle ?? 0;
  const creditsLimit = summary?.credits.monthlyGrant ?? 0;
  const pagesUsed = summary?.pages.consumedThisCycle ?? 0;
  const pagesLimit = summary?.pages.monthlyGrant ?? 0;
  const cycleLabel = summary
    ? formatCopy(copy.billing.cycleRange, {
        start: format.date(summary.cycleStartAt),
        end: format.date(summary.cycleEndAt),
      })
    : loading
      ? copy.billing.loadingCycle
      : "--";
  const billingRows = [
    {
      label: copy.common.cycle,
      value: cycleLabel,
      detail: summary ? formatCycleSource(summary.cycleSource, copy) : "--",
    },
    {
      label: copy.common.credits,
      value: summary
        ? formatCopy(copy.billing.usedOfLimit, {
            used: format.number(creditsUsed),
            limit: format.number(creditsLimit),
          })
        : loading
          ? copy.billing.loadingValue
          : "-- / --",
      detail: summary
        ? formatCopy(copy.billing.availableCount, {
            count: format.number(summary.credits.available),
          })
        : copy.billing.creditsUnavailable,
    },
    {
      label: copy.common.pages,
      value: summary
        ? formatCopy(copy.billing.usedOfLimit, {
            used: format.number(pagesUsed),
            limit: format.number(pagesLimit),
          })
        : loading
          ? copy.billing.loadingValue
          : "-- / --",
      detail: summary
        ? formatCopy(copy.billing.availableCount, {
            count: format.number(summary.pages.available),
          })
        : copy.billing.pagesUnavailable,
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
    subscription?.capabilities?.updateSeats === true &&
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
            label: copy.billing.seatPreview.theoreticalRefund,
            value: seatPreviewBilling
              ? format.currency(
                  seatPreviewBilling.theoreticalRefundCents,
                  seatPreviewBilling.currency,
                )
              : "--",
          },
          {
            label: copy.billing.seatPreview.refundOrCredit,
            value: seatPreviewBilling
              ? format.currency(
                  seatPreviewBilling.actualRefundCents,
                  seatPreviewBilling.currency,
                )
              : "--",
          },
          {
            label: copy.billing.seatPreview.notRefundable,
            value: seatPreviewBilling
              ? format.currency(
                  seatPreviewBilling.unrefundedCents,
                  seatPreviewBilling.currency,
                )
              : "--",
          },
          {
            label: copy.billing.seatPreview.refundRatio,
            value: seatPreviewQuota
              ? format.percent(seatPreviewQuota.refundRatio)
              : "--",
          },
          {
            label: copy.billing.seatPreview.creditsDeducted,
            value: seatPreviewQuota
              ? formatCopy(copy.billing.usedOfLimit, {
                  used: format.number(seatPreviewQuota.actualCredits),
                  limit: format.number(seatPreviewQuota.targetCredits),
                })
              : "--",
          },
          {
            label: copy.billing.seatPreview.pagesDeducted,
            value: seatPreviewQuota
              ? formatCopy(copy.billing.usedOfLimit, {
                  used: format.number(seatPreviewQuota.actualPages),
                  limit: format.number(seatPreviewQuota.targetPages),
                })
              : "--",
          },
          {
            label: copy.billing.seatPreview.billingAction,
            value: formatSeatProviderAction(
              seatPreviewBilling?.providerAction,
              copy,
            ),
          },
        ]
      : [
          {
            label: copy.billing.seatPreview.estimatedCharge,
            value: seatPreviewBilling
              ? format.currency(
                  seatPreviewBilling.estimatedChargeCents,
                  seatPreviewBilling.currency,
                )
              : "--",
          },
          {
            label: copy.billing.seatPreview.billingAction,
            value: formatSeatProviderAction(
              seatPreviewBilling?.providerAction,
              copy,
            ),
          },
        ];

  return (
    <>
      <div className="w-full max-w-2xl divide-y divide-border/60">
        {/* ── Header ── */}
        <div className="flex items-center justify-between gap-3 pb-7 pt-1">
          <p className="text-base font-semibold text-foreground">
            {copy.billing.title}
          </p>
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
                  {formatCopy(copy.billing.planLabel, { plan: planName })}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {planStateLabel} ·{" "}
                  {formatBillingInterval(subscription?.billingInterval, copy)}
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

        <TopupActions teamId={teamId} />

        {!isPersonal && (
          <div className="pt-7">
            <div className="mb-4 flex items-center justify-between gap-3">
              <p className="text-base font-semibold text-foreground">
                {copy.billing.seatsSectionTitle}
              </p>
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
                {isSubscriptionActive
                  ? copy.billing.updateSeats
                  : copy.billing.addSeats}
              </Button>
            </div>
            <div className="rounded-lg border border-border px-4 py-3">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {summary
                      ? formatCopy(copy.billing.seatsUsedOfLimit, {
                          used: format.number(seatsUsed),
                          limit: format.number(seatsLimit),
                        })
                      : loading
                        ? copy.billing.loadingSeats
                        : copy.billing.seatsUnknown}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {summary
                      ? formatCopy(copy.billing.seatsRemaining, {
                          count: format.number(seatsRemaining),
                        })
                      : copy.billing.seatsUnavailable}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <input
                    aria-label={copy.billing.totalSeatsLabel}
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
                    {copy.billing.seatsTotalSuffix}
                  </span>
                </div>
              </div>
              {isSubscriptionActive && targetSeatCount < seatsLimit && (
                <p className="mt-3 text-xs text-muted-foreground">
                  {copy.billing.seatReductionNotice}
                </p>
              )}
              {isSubscriptionActive && targetSeatCount > seatsLimit && (
                <p className="mt-3 text-xs text-muted-foreground">
                  {copy.billing.seatIncreaseNotice}
                </p>
              )}
              {isSubscriptionActive && targetSeatCount === seatsLimit && (
                <p className="mt-3 text-xs text-muted-foreground">
                  {copy.billing.seatCountSynced}
                </p>
              )}
            </div>
          </div>
        )}

        <div className="pt-7">
          <p className="mb-4 text-base font-semibold text-foreground">
            {copy.billing.subscriptionTitle}
          </p>
          <div className="overflow-hidden rounded-lg border border-border">
            {[
              {
                label: copy.common.status,
                value: subscriptionStatusLabel,
              },
              {
                label: copy.billing.rows.billingCadence,
                value: formatBillingInterval(
                  subscription?.billingInterval,
                  copy,
                ),
              },
              {
                label: copy.billing.rows.renewal,
                value: subscription?.cancelAtPeriodEnd
                  ? copy.billing.renewalCancels
                  : isSubscriptionActive
                    ? copy.billing.renewalAuto
                    : copy.billing.renewalNotScheduled,
              },
              {
                label: copy.billing.rows.lastUpdated,
                value: subscription?.lastEventAt
                  ? format.date(subscription.lastEventAt)
                  : copy.billing.noSubscriptionUpdates,
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
                ? copy.billing.reviewSeatIncrease
                : copy.billing.reviewSeatReduction}
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
                  {formatCopy(copy.billing.seatChangeSummary, {
                    current: format.number(seatPreview.currentSeatCount),
                    next: format.number(seatPreview.seatCount),
                  })}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {formatCopy(copy.billing.seatChangeDetail, {
                    used: format.number(seatPreview.seatsUsed),
                    pending: format.number(seatPreview.pendingInvitations),
                  })}
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
              {copy.common.cancel}
            </Button>
            <Button
              disabled={
                subscription?.provider === "waffo" ||
                seatActionLoading ||
                !seatPreview
              }
              onClick={() => void handleConfirmSeatChange()}
              size="sm"
              type="button"
            >
              {seatActionLoading
                ? copy.billing.updatingSeats
                : seatPreviewIsIncrease
                  ? copy.billing.confirmIncrease
                  : copy.billing.confirmReduction}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
