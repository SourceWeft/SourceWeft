"use client";

import { useEffect } from "react";
import {
  registerMobileServiceWorker,
  reportMobileLaunch,
} from "../../lib/mobile-app-shell";
import { liftMobileLaunchCover } from "./mobile-launch-cover";

/**
 * Lifts the mobile app's launch cover, starts its page cache and reports the launch time.
 * Renders nothing; a no-op outside the mobile app.
 */
export function MobileAppRuntime() {
  useEffect(() => {
    liftMobileLaunchCover();
    registerMobileServiceWorker();
    void reportMobileLaunch();
  }, []);
  return null;
}
