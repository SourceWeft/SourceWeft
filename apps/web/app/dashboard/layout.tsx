import "@fontsource-variable/noto-sans-arabic";
import "@fontsource-variable/noto-sans-devanagari";
import "@fontsource-variable/noto-sans-hebrew";
import "@fontsource-variable/noto-sans-jp";
import "@fontsource-variable/noto-sans-kr";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/noto-sans-tc";
import "@fontsource-variable/noto-sans-thai";

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
