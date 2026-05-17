import type { Metadata } from "next";
import type * as React from "react";

import { DashboardLayoutClient } from "./dashboard-layout-client";
import { NO_INDEX_METADATA } from "../seo";

export const metadata: Metadata = NO_INDEX_METADATA;

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <DashboardLayoutClient>{children}</DashboardLayoutClient>;
}
