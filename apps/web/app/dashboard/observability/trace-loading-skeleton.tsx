"use client";

import { useTranslations } from "next-intl";
import { Skeleton } from "@sourceweft/ui-web/components/ui/skeleton";
import { cn } from "@sourceweft/ui-web/lib/utils";

// The app's shared Skeleton, so Observe pulses in the same tone as every
// other loading screen.
export function TraceSkeletonBlock({ className }: { className?: string }) {
  return <Skeleton className={cn("max-w-full", className)} />;
}

export function TraceSkeletonLine({ className }: { className?: string }) {
  return <TraceSkeletonBlock className={cn("h-3", className)} />;
}

/**
 * The trace list's toolbar before the page code arrives. Same containers,
 * gaps and control sizes as the real toolbar, so it wraps into the same rows
 * (two on a phone) and nothing moves when the real one replaces it.
 */
export function TraceListHeaderSkeleton() {
  return (
    <div className="border-b border-border px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {/* Filters (phone) / Hide filters (desktop) */}
          <TraceSkeletonBlock className="h-8 w-[73px] md:w-[99px]" />
          {/* All time, N loaded, Page size */}
          <TraceSkeletonBlock className="h-6 w-14 rounded-full" />
          <TraceSkeletonBlock className="h-6 w-16 rounded-full" />
          <TraceSkeletonBlock className="h-6 w-[102px]" />
        </div>
        <div className="flex items-center gap-2">
          {/* LLM Traces / MCP Activity tabs, then Refresh */}
          <TraceSkeletonBlock className="h-8 w-[190px]" />
          <TraceSkeletonBlock className="h-8 w-[82px]" />
        </div>
      </div>
    </div>
  );
}

export function TraceListSkeletonRows({
  allWorkspacesSelected,
}: {
  allWorkspacesSelected: boolean;
}) {
  const t = useTranslations("dashboardObservability");
  return (
    <>
      <div className="md:hidden">
        {Array.from({ length: 8 }).map((_, index) => (
          // Line boxes match TraceMobileRow (13px name, 11px meta lines), so
          // rows keep their height when the traces arrive.
          <div className="border-b border-border px-3 py-2.5" key={index}>
            <div className="flex min-w-0 items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex h-[19.5px] items-center">
                  <TraceSkeletonLine className="h-3.5 w-44" />
                </div>
                <div className="mt-0.5 flex h-[16.5px] items-center">
                  <TraceSkeletonLine className="w-64" />
                </div>
              </div>
              <TraceSkeletonBlock className="h-5 w-14 shrink-0 rounded-full" />
            </div>
            <div className="mt-1.5 flex h-[16.5px] min-w-0 items-center gap-2">
              <TraceSkeletonLine className="w-16" />
              <TraceSkeletonLine className="w-12" />
              <TraceSkeletonLine className="w-28" />
            </div>
          </div>
        ))}
      </div>
      <div className="hidden min-w-0 overflow-x-auto md:block">
        <table
          className={cn(
            "w-full table-fixed text-xs",
            allWorkspacesSelected ? "min-w-[1680px]" : "min-w-[1520px]",
          )}
        >
          <thead className="sticky top-0 z-10 border-b border-border bg-card text-left text-[11px] text-muted-foreground">
            <tr>
              <th className="w-[150px] px-3 py-1.5 font-medium">
                {t("table.columns.timestamp")}
              </th>
              <th className="w-[300px] px-3 py-1.5 font-medium">
                {t("table.columns.name")}
              </th>
              {allWorkspacesSelected ? (
                <th className="w-[160px] px-3 py-1.5 font-medium">
                  {t("table.columns.workspace")}
                </th>
              ) : null}
              <th className="w-[90px] px-3 py-1.5 font-medium">
                {t("table.columns.status")}
              </th>
              <th className="w-[90px] px-3 py-1.5 font-medium">
                {t("table.columns.latency")}
              </th>
              <th className="w-[150px] px-3 py-1.5 font-medium">
                {t("table.columns.model")}
              </th>
              <th className="w-[90px] px-3 py-1.5 font-medium">
                {t("table.columns.tokens")}
              </th>
              <th className="w-[90px] px-3 py-1.5 font-medium">
                {t("table.columns.obs")}
              </th>
              <th className="w-[190px] px-3 py-1.5 font-medium">
                {t("table.columns.sessionId")}
              </th>
              <th className="w-[140px] px-3 py-1.5 font-medium">
                {t("table.columns.user")}
              </th>
              <th className="w-[190px] px-3 py-1.5 font-medium">
                {t("table.columns.traceId")}
              </th>
              <th className="w-[36px] px-3 py-1.5 font-medium" />
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 12 }).map((_, index) => (
              <tr className="border-b border-border" key={index}>
                <td className="px-3 py-2">
                  <TraceSkeletonLine className="w-28" />
                </td>
                <td className="px-3 py-2">
                  <div className="space-y-2">
                    <TraceSkeletonLine className="w-48" />
                    <TraceSkeletonLine className="w-36" />
                  </div>
                </td>
                {allWorkspacesSelected ? (
                  <td className="px-3 py-2">
                    <TraceSkeletonLine className="w-28" />
                  </td>
                ) : null}
                <td className="px-3 py-2">
                  <TraceSkeletonBlock className="h-5 w-16 rounded-full" />
                </td>
                <td className="px-3 py-2">
                  <TraceSkeletonLine className="w-14" />
                </td>
                <td className="px-3 py-2">
                  <TraceSkeletonLine className="w-28" />
                </td>
                <td className="px-3 py-2">
                  <TraceSkeletonLine className="w-12" />
                </td>
                <td className="px-3 py-2">
                  <TraceSkeletonLine className="w-10" />
                </td>
                <td className="px-3 py-2">
                  <TraceSkeletonLine className="w-36" />
                </td>
                <td className="px-3 py-2">
                  <TraceSkeletonLine className="w-24" />
                </td>
                <td className="px-3 py-2">
                  <TraceSkeletonLine className="w-36" />
                </td>
                <td className="px-3 py-2">
                  <TraceSkeletonBlock className="ml-auto size-4 rounded-sm" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
