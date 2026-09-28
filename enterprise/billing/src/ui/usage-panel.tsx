"use client";
import { useBillingUiHost, type BillingUiHost } from "./context";

import * as React from "react";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { Progress } from "@sourceweft/ui-web/components/ui/progress";
import { cn } from "@sourceweft/ui-web/lib/utils";

import { BillingPlanActionControls } from "./billing-plan-action-controls";
import { formatCopy } from "../messages";
import {
  formatLedgerActivityChange,
  formatLedgerDetail,
  formatLedgerUnit,
  formatPlanName,
  isLedgerEntryInCycle,
  isPersonalBillingOrg,
  resolveBillingTeamId,
  usageActivityFilters,
  USAGE_ACTIVITY_PAGE_SIZE,
} from "./billing-utils";
import { useBillingCopy } from "./use-billing-copy";

import type {
  BillingInterval,
  BillingLedgerEntry,
  BillingOrg,
  BillingSubscription,
  BillingSummary,
  UsageActivityFilter,
  UsageActivityRow,
} from "./types";
import { useBillingPlanAction } from "./use-billing-plan-action";

export function UsagePanel() {
  const {
    authClient,
    billingClient,
    SettingsSkeletonBlock,
    UsagePanelSkeleton,
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
  const [ledger, setLedger] = React.useState<BillingLedgerEntry[]>([]);
  const [activityCursor, setActivityCursor] = React.useState<string | null>(
    null,
  );
  const [loading, setLoading] = React.useState(
    () => Boolean(teamId) || resolvingPersonalTeamId,
  );
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
        setError(err instanceof Error ? err.message : copy.usage.failedToLoad);
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
  }, [copy, resolvingPersonalTeamId, teamId]);

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
        err instanceof Error ? err.message : copy.usage.failedToLoadActivity,
      );
    } finally {
      setLoadingMoreActivity(false);
    }
  }, [activityCursor, copy, loadingMoreActivity, teamId]);

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
      detail: formatLedgerDetail(entry, copy),
      date: format.dateTime(entry.createdAt),
      change: formatLedgerActivityChange(entry, copy, format),
      key: entry.id,
      unitType: entry.unitType,
    }));
  const activityRows = ledgerActivityRows;
  const totalActivityRowCount = filteredLedgerEntries.length;
  const hasMoreActivityRows =
    activityRows.length < totalActivityRowCount || Boolean(activityCursor);
  const planLabel = summary
    ? (copy.common.planNames[summary.planFamily] ??
      formatPlanName(summary.planFamily, isPersonal))
    : isPersonal
      ? copy.common.personal
      : copy.common.team;
  const data = {
    plan: planLabel,
    creditsLabel: summary
      ? formatCopy(copy.usage.creditsLabel, {
          used: format.number(creditsUsed),
          limit: format.number(creditsLimit),
        })
      : loading
        ? copy.usage.loadingCredits
        : copy.usage.creditsUnknown,
    creditsPercent,
    pagesLabel: summary
      ? formatCopy(copy.usage.pagesLabel, {
          used: format.number(pagesUsed),
          left: format.number(summary.pages.available),
        })
      : loading
        ? copy.usage.loadingPages
        : copy.usage.pagesUnknown,
    pagesPercent,
    pagesWallet: summary
      ? formatCopy(copy.usage.pagesWallet, {
          monthly: format.number(summary.pages.monthlyBalance),
          addOn: format.number(summary.pages.addOnBalance),
        })
      : loading
        ? copy.usage.pagesWalletLoading
        : copy.usage.pagesWalletUnknown,
    seatsLabel: summary
      ? formatCopy(copy.usage.seatsLabel, {
          used: format.number(seatsUsed),
          limit: format.number(seatsLimit),
        })
      : loading
        ? copy.usage.loadingSeats
        : copy.usage.seatsUnknown,
    seatsUsage: summary
      ? formatCopy(copy.usage.seatsUsage, {
          used: format.number(seatsUsed),
          remaining: format.number(summary.seats.remaining),
        })
      : loading
        ? copy.usage.loadingSeats
        : copy.usage.seatsUsageUnknown,
  };
  const emptyActivityLabel = loading
    ? copy.usage.loadingActivity
    : teamId
      ? activityFilter === "all"
        ? copy.usage.noActivity
        : formatCopy(copy.usage.noActivityForUnit, {
            unit: formatLedgerUnit(activityFilter, copy),
          })
      : copy.usage.accountUnavailable;
  const planAction = useBillingPlanAction({
    billingPeriod,
    isPersonal,
    summary,
    subscription,
    teamId,
  });
  const loadingInitialUsage = loading && !summary && ledger.length === 0;

  if (loadingInitialUsage) {
    return <UsagePanelSkeleton />;
  }

  return (
    <div className="w-full max-w-2xl divide-y divide-border/60">
      {/* ── Header ── */}
      <div className="flex items-center justify-between gap-3 pb-7 pt-1">
        <p className="text-base font-semibold text-foreground">
          {copy.usage.title}
        </p>
        <OrgSwitcher />
      </div>

      {/* ── Plan + credits ── */}
      <div className="py-7">
        <div className="overflow-hidden rounded-lg border border-border">
          <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
            <p className="text-sm font-medium text-foreground">
              {formatCopy(copy.usage.planLabel, { plan: data.plan })}
            </p>
            <BillingPlanActionControls
              action={planAction}
              billingPeriod={billingPeriod}
              onBillingPeriodChange={setBillingPeriod}
            />
          </div>
          <div className="px-4 py-3">
            <div className="mb-1.5 flex items-center justify-between text-xs">
              <span className="text-muted-foreground">
                {copy.common.credits}
              </span>
              <span className="font-medium text-foreground">
                {data.creditsLabel}
              </span>
            </div>
            <Progress className="h-1.5 bg-muted" value={data.creditsPercent} />
          </div>
          <div className="border-t border-border px-4 py-3">
            <div className="mb-1.5 flex items-center justify-between gap-3 text-xs">
              <span className="text-muted-foreground">{copy.common.pages}</span>
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
                <span className="text-muted-foreground">
                  {copy.common.seats}
                </span>
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
          <p className="text-base font-semibold text-foreground">
            {copy.usage.activityTitle}
          </p>
          <div
            aria-label={copy.usage.filterAriaLabel}
            className="flex rounded-lg border border-border bg-muted/40 p-0.5"
            role="group"
          >
            {usageActivityFilters.map((filterValue) => (
              <button
                aria-pressed={activityFilter === filterValue}
                className={cn(
                  "min-w-14 rounded-md px-2.5 py-1 text-xs transition-colors",
                  activityFilter === filterValue
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
                key={filterValue}
                onClick={() => {
                  setActivityFilter(filterValue);
                  setActivityVisibleCount(USAGE_ACTIVITY_PAGE_SIZE);
                }}
                type="button"
              >
                {copy.usage.filters[filterValue]}
              </button>
            ))}
          </div>
        </div>
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/30">
              <tr>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">
                  {copy.usage.table.detail}
                </th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">
                  {copy.usage.table.date}
                </th>
                <th className="px-4 py-2.5 text-right text-xs font-medium text-muted-foreground">
                  {copy.usage.table.usage}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {loading ? (
                Array.from({ length: 5 }).map((_, index) => (
                  <tr key={index}>
                    <td className="px-4 py-2.5">
                      <SettingsSkeletonBlock className="h-3 w-44 max-w-full" />
                    </td>
                    <td className="px-4 py-2.5">
                      <SettingsSkeletonBlock className="h-3 w-24" />
                    </td>
                    <td className="px-4 py-2.5">
                      <SettingsSkeletonBlock className="ml-auto h-3 w-14" />
                    </td>
                  </tr>
                ))
              ) : activityRows.length > 0 ? (
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
              {loadingMoreActivity
                ? copy.usage.loadingMore
                : copy.usage.loadMore}
            </Button>
          </div>
        )}
        {error && <p className="mt-3 text-xs text-muted-foreground">{error}</p>}
      </div>
    </div>
  );
}
