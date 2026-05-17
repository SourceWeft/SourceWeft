"use client";

import { sendGAEvent } from "@next/third-parties/google";

type AnalyticsPrimitive = string | number | boolean | null | undefined;
export type AnalyticsParams = Record<
  string,
  AnalyticsPrimitive | AnalyticsPrimitive[] | Record<string, AnalyticsPrimitive>[]
>;

export function trackEvent(name: string, params?: AnalyticsParams) {
  sendGAEvent("event", name, params ?? {});
}
