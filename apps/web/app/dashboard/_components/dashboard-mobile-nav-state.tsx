"use client";

import * as React from "react";

export type DashboardMobileView = "main" | "me" | "observability";

type DashboardMobileNavState = {
  view: DashboardMobileView;
  openMain: () => void;
  openMe: () => void;
  openObservability: () => void;
};

const DashboardMobileNavContext =
  React.createContext<DashboardMobileNavState | null>(null);

export function DashboardMobileNavProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [view, setView] = React.useState<DashboardMobileView>("main");

  const value = React.useMemo<DashboardMobileNavState>(
    () => ({
      view,
      openMain: () => setView("main"),
      openMe: () => setView("me"),
      openObservability: () => setView("observability"),
    }),
    [view],
  );

  return (
    <DashboardMobileNavContext.Provider value={value}>
      {children}
    </DashboardMobileNavContext.Provider>
  );
}

export function useDashboardMobileNav() {
  const context = React.useContext(DashboardMobileNavContext);
  if (!context) {
    throw new Error(
      "useDashboardMobileNav must be used within DashboardMobileNavProvider",
    );
  }
  return context;
}
