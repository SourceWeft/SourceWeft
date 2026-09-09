"use client";
import { useBillingUiHost, type BillingUiHost } from "./context";
import type { BillingClient } from "@sourceweft/sdk";
import { useCallback, useEffect, useRef, useState } from "react";
import { Gauge } from "lucide-react";
import { Progress } from "@sourceweft/ui-web/components/ui/progress";
import { isPersonalOrganization } from "@sourceweft/contracts/organization-metadata";

type BillingSummary = Awaited<ReturnType<BillingClient["getSummary"]>>;
type BillingOrg = {
  id: string;
  metadata?: unknown;
  name: string;
  slug?: string;
};

function resolveSidebarBillingTeamId(input: {
  activeOrg?: BillingOrg | null;
  orgs?: BillingOrg[] | null;
}) {
  if (input.activeOrg?.id) {
    return input.activeOrg.id;
  }

  return input.orgs?.find(isPersonalOrganization)?.id ?? null;
}

function formatUsageNumber(value: number) {
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 1,
    notation: "compact",
  }).format(value);
}

function formatUsageDate(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "--";
  }

  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
  }).format(date);
}

export function SidebarUsageSummary({
  onOpenUsage,
}: {
  onOpenUsage?: () => void;
}) {
  const { billingClient, authClient, subscribeDashboardBillingSummaryRefresh } =
    useBillingUiHost();

  const { data: orgs } = authClient.useListOrganizations();
  const { data: activeOrg } = authClient.useActiveOrganization();
  const activeOrgRecord = activeOrg as BillingOrg | null | undefined;
  const orgList = (orgs ?? []) as BillingOrg[];
  const teamId = resolveSidebarBillingTeamId({
    activeOrg: activeOrgRecord,
    orgs: orgList,
  });
  const resolvingTeamId = !activeOrgRecord && orgs === undefined;
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [hasError, setHasError] = useState(false);
  const mountedRef = useRef(false);
  const requestIdRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadSummary = useCallback(
    async (options?: { silent?: boolean }) => {
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      const silent = options?.silent === true;

      if (!teamId) {
        setSummary(null);
        setLoading(resolvingTeamId);
        setHasError(false);
        return;
      }

      if (!silent) {
        setLoading(true);
      }
      setHasError(false);

      try {
        const nextSummary = await billingClient.getSummary(teamId);

        if (mountedRef.current && requestIdRef.current === requestId) {
          setSummary(nextSummary);
        }
      } catch {
        if (mountedRef.current && requestIdRef.current === requestId) {
          if (!silent) {
            setSummary(null);
          }
          setHasError(true);
        }
      } finally {
        if (mountedRef.current && requestIdRef.current === requestId) {
          setLoading(false);
        }
      }
    },
    [resolvingTeamId, teamId],
  );

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  useEffect(
    () =>
      subscribeDashboardBillingSummaryRefresh(() => {
        void loadSummary({ silent: true });
      }),
    [loadSummary],
  );

  const creditsUsed = summary?.credits.consumedThisCycle ?? 0;
  const creditsLimit = summary?.credits.monthlyGrant ?? 0;
  const creditsPercent =
    creditsLimit > 0 ? Math.min(100, (creditsUsed / creditsLimit) * 100) : 0;
  const creditsLabel = summary
    ? `${formatUsageNumber(creditsUsed)} / ${formatUsageNumber(creditsLimit)}`
    : loading
      ? "Loading"
      : "-- / --";
  const pagesAvailable = summary?.pages.available ?? 0;
  const cycleEndsAt = summary ? formatUsageDate(summary.cycleEndAt) : "--";

  return (
    <button
      aria-label="Open usage"
      className="w-full rounded-lg border border-sidebar-border bg-sidebar-accent/35 p-2.5 text-left transition-colors hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={onOpenUsage}
      type="button"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <Gauge className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate text-[10px] font-medium text-sidebar-foreground">
            Usage
          </span>
        </div>
        <span className="shrink-0 text-[10px] font-medium text-sidebar-foreground">
          {summary ? `${Math.round(creditsPercent)}%` : loading ? "..." : "--"}
        </span>
      </div>

      <div className="mt-2">
        <div className="mb-1 flex items-center justify-between gap-2 text-[10px]">
          <span className="text-muted-foreground">Credits</span>
          <span className="truncate text-right font-medium text-sidebar-foreground">
            {creditsLabel}
          </span>
        </div>
        <Progress className="h-1 bg-sidebar-border/70" value={creditsPercent} />
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2 text-[10px]">
        <div className="min-w-0">
          <p className="truncate text-muted-foreground">Pages left</p>
          <p className="truncate font-medium text-sidebar-foreground">
            {summary
              ? formatUsageNumber(pagesAvailable)
              : loading
                ? "..."
                : "--"}
          </p>
        </div>
        <div className="min-w-0 text-right">
          <p className="truncate text-muted-foreground">Cycle ends</p>
          <p className="truncate font-medium text-sidebar-foreground">
            {hasError ? "Unavailable" : cycleEndsAt}
          </p>
        </div>
      </div>
    </button>
  );
}
