"use client";

import { useTranslations } from "next-intl";
import { cn } from "@sourceweft/ui-web/lib/utils";

export function TraceSkeletonBlock({ className }: { className?: string }) {
  return (
    <div className={cn("animate-pulse rounded-md bg-muted/80", className)} />
  );
}

export function TraceSkeletonLine({ className }: { className?: string }) {
  return <TraceSkeletonBlock className={cn("h-3", className)} />;
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
          <div className="border-b border-border px-3 py-2.5" key={index}>
            <div className="flex min-w-0 items-center justify-between gap-3">
              <div className="min-w-0 flex-1 space-y-2">
                <TraceSkeletonLine className="w-44" />
                <TraceSkeletonLine className="w-64 max-w-full" />
              </div>
              <TraceSkeletonBlock className="h-5 w-14 rounded-full" />
            </div>
            <div className="mt-2 flex min-w-0 gap-2">
              <TraceSkeletonLine className="w-16" />
              <TraceSkeletonLine className="w-14" />
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
