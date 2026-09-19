import "@fontsource-variable/noto-sans-arabic";
import "@fontsource-variable/noto-sans-devanagari";
import "@fontsource-variable/noto-sans-hebrew";
import "@fontsource-variable/noto-sans-jp";
import "@fontsource-variable/noto-sans-kr";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/noto-sans-tc";
import "@fontsource-variable/noto-sans-thai";

import type { Metadata, Viewport } from "next";
import type * as React from "react";

import { DashboardLayoutClient } from "./dashboard-layout-client";
import { NO_INDEX_METADATA } from "../seo";

export const metadata: Metadata = NO_INDEX_METADATA;

// The native mobile shell renders these routes as an app, where a pinch zoom — or iOS
// auto-zooming onto a focused input — just breaks the layout. Safari ignores this for
// accessibility, so public marketing routes keep their pinch zoom.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <DashboardLayoutClient>{children}</DashboardLayoutClient>;
}
