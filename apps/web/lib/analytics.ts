import type { AnalyticsValue } from "./analytics/catalog";

export { trackEvent } from "./analytics/client";
export type AnalyticsParams = Record<string, AnalyticsValue>;
