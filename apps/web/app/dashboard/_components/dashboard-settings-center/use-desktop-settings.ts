"use client";

import { useEffect, useState } from "react";
import { desktopBridge } from "../../../../lib/desktop-bridge";

/** Desktop platforms that can host local execution (macOS Seatbelt, Linux bubblewrap). */
const LOCAL_EXECUTION_PLATFORMS: readonly string[] = ["macos", "linux"];

/** Keep desktop-only settings out of ordinary browser sessions. */
export function useDesktopSettings() {
  const [platform, setPlatform] = useState<string | null>(null);
  useEffect(() => {
    if (!desktopBridge.isAvailable()) return;
    let active = true;
    void desktopBridge.info().then(
      (info) => {
        if (active && info.isDesktop) setPlatform(info.platform);
      },
      () => {},
    );
    return () => {
      active = false;
    };
  }, []);
  return {
    isDesktop: platform !== null,
    isLocalPc: platform !== null && LOCAL_EXECUTION_PLATFORMS.includes(platform),
  };
}
