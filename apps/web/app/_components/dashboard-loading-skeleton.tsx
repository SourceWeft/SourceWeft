"use client";

import { usePathname } from "next/navigation";
import { DashboardShellRouteSkeleton } from "./route-loading-skeleton";

export function DashboardLoadingSkeleton() {
  const pathname = usePathname();
  return <DashboardShellRouteSkeleton pathname={pathname} />;
}
