import type { AnalyticsValue } from "../catalog";
import type { AnalyticsDestination } from "./types";

declare global {
  interface Window {
    umami?: {
      track(name: string, data?: Record<string, unknown>): void;
      // Only newer Umami v2 releases have identify.
      identify?(data: Record<string, unknown>): void;
    };
  }
}

type UmamiValue = string | number | boolean;

/** Umami stores flat values; GA4's `items` array becomes `item_ids`. */
export function toUmamiData(
  params: Record<string, AnalyticsValue>,
): Record<string, UmamiValue> {
  const data: Record<string, UmamiValue> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      if (key === "items") {
        data.item_ids = value.map((item) => String(item.item_id)).join(",");
      }
      continue;
    }
    data[key] = value;
  }
  return data;
}

export function createUmamiDestination(): AnalyticsDestination {
  return {
    id: "umami",
    requiresConsent: false,
    isReady: () => typeof window.umami?.track === "function",
    setContext: (ctx) =>
      window.umami?.identify?.(toUmamiData({ ...ctx })),
    track: (name, params) => window.umami?.track(name, toUmamiData(params)),
  };
}
