import type { AnalyticsValue } from "../catalog";
import type { AnalyticsContext } from "../context";

export type DestinationId = "gtm" | "umami";

/** One analytics tool. Each destination adapts events to its own format. */
export interface AnalyticsDestination {
  id: DestinationId;
  /** Skipped while the viewer has not consented to analytics. */
  requiresConsent: boolean;
  /** Whether the tool's script has loaded and can take calls now. */
  isReady(): boolean;
  setContext(ctx: AnalyticsContext): void;
  track(name: string, params: Record<string, AnalyticsValue>): void;
}
