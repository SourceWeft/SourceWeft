"use client";

import { useDesktopAuthDeepLink } from "../../lib/use-desktop-auth-deep-link";

export function DesktopAuthListener() {
  useDesktopAuthDeepLink("/dashboard/chat");

  return null;
}
