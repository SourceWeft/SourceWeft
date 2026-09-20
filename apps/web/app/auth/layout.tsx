import type { Viewport } from "next";
import type * as React from "react";

// Sign-in is the first screen the native mobile shell renders. iOS auto-zooms onto a
// focused input unless scaling is pinned, which leaves the form scrolled off-centre.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
