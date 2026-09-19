"use client";

import { useEffect, useState } from "react";
import { detectPlatform, type DetectedPlatform } from "./detect-platform";

/** Starts from the server's User-Agent guess so the first paint already shows
 * the right button, then refines with client hints after mount. */
export function useDetectedPlatform(
  initial: DetectedPlatform = "unknown",
): DetectedPlatform {
  const [platform, setPlatform] = useState<DetectedPlatform>(initial);
  useEffect(() => {
    setPlatform(detectPlatform(window.navigator));
  }, []);
  return platform;
}
