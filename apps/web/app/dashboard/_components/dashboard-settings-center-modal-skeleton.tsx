"use client";

import type { SettingsCenterTab } from "./dashboard-settings-center/types";

type SkeletonProps = {
  className?: string;
};

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

export function SettingsSkeletonBlock({ className }: SkeletonProps) {
  return (
    <div className={cx("animate-pulse rounded-md bg-muted/80", className)} />
  );
}

function SettingsSkeletonLine({ className }: SkeletonProps) {
  return <SettingsSkeletonBlock className={cx("h-3", className)} />;
}

function PanelHeaderSkeleton({ action }: { action?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 pb-7 pt-1">
      <SettingsSkeletonLine className="h-4 w-24" />
      {action ? (
        <SettingsSkeletonBlock className="h-8 w-36 rounded-lg" />
      ) : null}
    </div>
  );
}

function SegmentedControlSkeleton() {
  return (
    <div className="flex rounded-lg border border-border bg-muted/40 p-0.5">
      {Array.from({ length: 3 }).map((_, index) => (
        <SettingsSkeletonBlock
          className={cx(
            "h-7 rounded-md",
            index === 0 ? "w-14 bg-background" : "w-16",
          )}
          key={index}
        />
      ))}
    </div>
  );
}

function TableRowsSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      {Array.from({ length: rows }).map((_, index) => (
        <div
          className={cx(
            "flex items-center justify-between gap-4 px-4 py-3",
            index !== 0 && "border-t border-border/60",
          )}
          key={index}
        >
          <div className="min-w-0 flex-1 space-y-2">
            <SettingsSkeletonLine
              className={index % 2 ? "w-48 max-w-full" : "w-36 max-w-full"}
            />
            <SettingsSkeletonLine className="w-24" />
          </div>
          <SettingsSkeletonLine className="w-16 shrink-0" />
        </div>
      ))}
    </div>
  );
}

export function AccountPanelSkeleton() {
  return (
    <div className="w-full max-w-2xl divide-y divide-border/60">
      <div className="pb-7 pt-1">
        <SettingsSkeletonLine className="mb-5 h-4 w-24" />
        <div className="flex gap-5">
          <SettingsSkeletonBlock className="h-14 w-14 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-2">
            <SettingsSkeletonLine className="w-28" />
            <SettingsSkeletonBlock className="h-9 rounded-lg" />
          </div>
        </div>
      </div>

      <div className="py-7">
        <SettingsSkeletonLine className="mb-4 h-4 w-28" />
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-2">
            <SettingsSkeletonLine className="w-20" />
            <SettingsSkeletonLine className="w-48 max-w-full" />
          </div>
          <SegmentedControlSkeleton />
        </div>
      </div>

      <div className="py-7">
        <SettingsSkeletonLine className="mb-4 h-4 w-28" />
        <div className="space-y-3">
          {Array.from({ length: 2 }).map((_, index) => (
            <div
              className="flex items-center justify-between gap-4"
              key={index}
            >
              <div className="space-y-2">
                <SettingsSkeletonLine className="w-36" />
                <SettingsSkeletonLine className="w-24" />
              </div>
              <SettingsSkeletonBlock className="h-8 w-32 rounded-lg" />
            </div>
          ))}
        </div>
      </div>

      <div className="pt-7">
        <SettingsSkeletonLine className="mb-4 h-4 w-24" />
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-2">
              <SettingsSkeletonLine className="w-48 max-w-full" />
              <SettingsSkeletonLine className="w-28" />
            </div>
            <SettingsSkeletonBlock className="h-8 w-20 rounded-lg" />
          </div>
          <div className="flex items-start justify-between gap-4 rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3">
            <div className="space-y-2">
              <SettingsSkeletonLine className="w-28 bg-destructive/20" />
              <SettingsSkeletonLine className="w-64 max-w-full" />
            </div>
            <SettingsSkeletonBlock className="h-8 w-16 shrink-0 rounded-lg bg-destructive/20" />
          </div>
        </div>
      </div>
    </div>
  );
}

export function TeamPanelSkeleton() {
  return (
    <div className="w-full max-w-2xl divide-y divide-border/60">
      <div className="pb-7 pt-1">
        <div className="mb-4 flex items-center justify-between gap-3">
          <SettingsSkeletonLine className="h-4 w-20" />
          <SettingsSkeletonBlock className="h-8 w-28 rounded-lg" />
        </div>
        <SettingsSkeletonBlock className="h-11 rounded-lg" />
      </div>

      <div className="py-7">
        <div className="mb-4 flex items-center justify-between gap-3">
          <SettingsSkeletonLine className="h-4 w-24" />
          <SettingsSkeletonBlock className="h-8 w-20 rounded-lg" />
        </div>
        <TableRowsSkeleton rows={4} />
      </div>
    </div>
  );
}

export function UsagePanelSkeleton() {
  return (
    <div className="w-full max-w-2xl divide-y divide-border/60">
      <PanelHeaderSkeleton action />

      <div className="py-7">
        <div className="overflow-hidden rounded-lg border border-border">
          <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
            <SettingsSkeletonLine className="h-4 w-28" />
            <SegmentedControlSkeleton />
          </div>
          {Array.from({ length: 3 }).map((_, index) => (
            <div
              className={cx(
                "px-4 py-3",
                index !== 0 && "border-t border-border",
              )}
              key={index}
            >
              <div className="mb-2 flex items-center justify-between gap-3">
                <SettingsSkeletonLine className="w-16" />
                <SettingsSkeletonLine className="w-32" />
              </div>
              <SettingsSkeletonBlock className="h-1.5 rounded-full" />
              {index > 0 ? (
                <SettingsSkeletonLine className="mt-2 w-40" />
              ) : null}
            </div>
          ))}
        </div>
      </div>

      <div className="pt-7">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <SettingsSkeletonLine className="h-4 w-24" />
          <SegmentedControlSkeleton />
        </div>
        <TableRowsSkeleton rows={5} />
      </div>
    </div>
  );
}

export function BillingPanelSkeleton() {
  return (
    <div className="w-full max-w-2xl divide-y divide-border/60">
      <PanelHeaderSkeleton action />

      <div className="py-7">
        <div className="overflow-hidden rounded-lg border border-border bg-background">
          <div className="flex flex-col gap-4 border-b border-border px-4 py-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <SettingsSkeletonBlock className="h-6 w-32 rounded-full" />
              <SettingsSkeletonLine className="mt-3 h-5 w-36" />
              <SettingsSkeletonLine className="mt-2 w-44" />
            </div>
            <SegmentedControlSkeleton />
          </div>
          <div className="grid gap-0 divide-y divide-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
            {Array.from({ length: 3 }).map((_, index) => (
              <div className="px-4 py-3" key={index}>
                <SettingsSkeletonLine className="w-16" />
                <SettingsSkeletonLine className="mt-2 h-4 w-28" />
                <SettingsSkeletonLine className="mt-2 w-24" />
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="py-7">
        <div className="mb-4 flex items-center justify-between gap-3">
          <SettingsSkeletonLine className="h-4 w-20" />
          <SettingsSkeletonBlock className="h-8 w-24 rounded-lg" />
        </div>
        <SettingsSkeletonBlock className="h-20 rounded-lg" />
      </div>

      <div className="pt-7">
        <SettingsSkeletonLine className="mb-4 h-4 w-28" />
        <TableRowsSkeleton rows={4} />
      </div>
    </div>
  );
}

export function SettingsCenterPanelSkeleton({
  activeTab = "account",
}: {
  activeTab?: SettingsCenterTab;
}) {
  if (activeTab === "team") {
    return <TeamPanelSkeleton />;
  }
  if (activeTab === "usage") {
    return <UsagePanelSkeleton />;
  }
  if (activeTab === "billing") {
    return <BillingPanelSkeleton />;
  }
  return <AccountPanelSkeleton />;
}

export function DashboardSettingsCenterModalSkeleton({
  activeTab = "account",
}: {
  activeTab?: SettingsCenterTab;
}) {
  const navItems: SettingsCenterTab[] = [
    "account",
    "team",
    "usage",
    "billing",
    "approvals",
  ];

  return (
    <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm">
      <div
        aria-modal="true"
        className="fixed left-1/2 top-1/2 z-50 h-[min(780px,calc(100svh-2rem))] w-[calc(100vw-2rem)] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl border border-border/80 bg-background p-0 shadow-2xl sm:w-[min(900px,calc(100vw-2rem))] sm:max-w-[min(900px,calc(100vw-2rem))]"
        role="dialog"
      >
        <div className="grid h-full grid-cols-1 sm:grid-cols-[180px_minmax(0,1fr)]">
          <aside className="flex min-h-0 flex-col border-b border-border/70 bg-muted/30 sm:border-b-0 sm:border-r">
            <div className="border-b border-border/70 px-4 py-3.5">
              <div className="flex items-center gap-2.5">
                <SettingsSkeletonBlock className="h-7 w-7 shrink-0 rounded-full" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <SettingsSkeletonLine className="w-24" />
                  <SettingsSkeletonLine className="w-32" />
                </div>
              </div>
            </div>

            <nav className="flex-1 overflow-y-auto px-2.5 py-2.5">
              <div className="space-y-0.5">
                {navItems.map((item) => (
                  <div
                    className={cx(
                      "flex h-8 items-center gap-2.5 rounded-md px-2.5",
                      item === activeTab && "bg-background shadow-sm",
                    )}
                    key={item}
                  >
                    <SettingsSkeletonBlock className="h-3.5 w-3.5 shrink-0 rounded-sm" />
                    <SettingsSkeletonLine className="w-20" />
                  </div>
                ))}
              </div>
            </nav>
          </aside>

          <div className="relative min-h-0 overflow-hidden">
            <SettingsSkeletonBlock className="absolute right-3 top-3 z-10 h-7 w-7 rounded-md" />
            <div className="absolute inset-0 overflow-y-auto overflow-x-hidden overscroll-contain px-6 pb-10 pt-6 pr-12">
              <SettingsCenterPanelSkeleton activeTab={activeTab} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
