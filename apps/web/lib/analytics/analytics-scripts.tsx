"use client";

import { GoogleTagManager } from "@next/third-parties/google";

import type { AnalyticsRuntimeConfig } from "./client";

/** Loads the script of every analytics tool enabled in the runtime config. */
export function AnalyticsScripts({
  config,
}: {
  config: AnalyticsRuntimeConfig;
}) {
  return config.gtmId ? <GoogleTagManager gtmId={config.gtmId} /> : null;
}
