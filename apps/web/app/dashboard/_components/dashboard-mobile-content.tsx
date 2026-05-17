"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { ArrowLeft } from "lucide-react";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { ObservabilityRouteSkeleton } from "../../_components/route-loading-skeleton";
import { DashboardMobileMe } from "./dashboard-mobile-me";
import { useDashboardMobileNav } from "./dashboard-mobile-nav-state";

const ObservabilityPage = dynamic(() => import("../observability/page"), {
  loading: () => <ObservabilityRouteSkeleton />,
  ssr: false,
});

export function DashboardMobileContent({
  children,
}: {
  children: React.ReactNode;
}) {
  const { openMe, view } = useDashboardMobileNav();

  if (view === "me") {
    return (
      <>
        <DashboardMobileMe />
        <div className="hidden min-h-0 flex-1 flex-col md:flex">
          {children}
        </div>
      </>
    );
  }

  if (view === "observability") {
    return (
      <>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden md:hidden">
          <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background px-3">
            <Button
              className="h-8 w-8"
              onClick={openMe}
              size="icon"
              type="button"
              variant="ghost"
            >
              <ArrowLeft className="h-4 w-4" />
              <span className="sr-only">Back</span>
            </Button>
            <div className="min-w-0 text-sm font-semibold text-foreground">
              Observe
            </div>
          </header>
          <div className="min-h-0 flex-1 overflow-hidden">
            <ObservabilityPage />
          </div>
        </div>
        <div className="hidden min-h-0 flex-1 flex-col md:flex">
          {children}
        </div>
      </>
    );
  }

  return <>{children}</>;
}
