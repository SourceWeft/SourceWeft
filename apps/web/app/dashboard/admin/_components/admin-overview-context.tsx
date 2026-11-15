"use client";

import * as React from "react";
import type { AdminOverviewResponse } from "@sourceweft/contracts";

export type AdminOverviewState = {
  /** `null` until the first answer, and when the numbers could not be read. */
  overview: AdminOverviewResponse | null;
  failed: boolean;
  /** Read the numbers again, after a decision changed a queue. */
  refresh: () => void;
};

const AdminOverviewContext = React.createContext<AdminOverviewState>({
  overview: null,
  failed: false,
  refresh: () => {},
});

export const AdminOverviewProvider = AdminOverviewContext.Provider;

/** The admin area's pending numbers, shared by the navigation and the pages. */
export function useAdminOverview() {
  return React.useContext(AdminOverviewContext);
}
