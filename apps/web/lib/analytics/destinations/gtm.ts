import type { AnalyticsDestination } from "./types";

declare global {
  interface Window {
    dataLayer?: unknown[];
  }
}

// Pushes straight onto `window.dataLayer` rather than using `sendGTMEvent`,
// which drops events sent before the GoogleTagManager component mounts. GTM
// processes entries already in the dataLayer when its script loads.
function push(entry: Record<string, unknown>) {
  window.dataLayer = window.dataLayer ?? [];
  window.dataLayer.push(entry);
}

export function createGtmDestination(): AnalyticsDestination {
  return {
    id: "gtm",
    requiresConsent: false,
    isReady: () => true,
    setContext: (ctx) => push({ event: "analytics_context", ...ctx }),
    track: (name, params) => push({ ...params, event: name }),
  };
}
