import { config } from "./config";

/** Beijing/Singapore time is UTC+8 year-round; independent of the host TZ. */
const OFFSET_MS = 8 * 60 * 60 * 1000;

export function nextMarketAiWindow(
  now = new Date(),
  offPeakOnly = config.market.aiOffPeakOnly,
): Date | null {
  if (!offPeakOnly) return null;
  const local = new Date(now.getTime() + OFFSET_MS);
  const weekday = local.getUTCDay();
  if (weekday === 0 || weekday === 6) return null;
  const hour = local.getUTCHours();
  const until =
    hour >= 9 && hour < 12 ? 12 : hour >= 14 && hour < 18 ? 18 : null;
  if (until === null) return null;
  local.setUTCHours(until, 0, 0, 0);
  return new Date(local.getTime() - OFFSET_MS);
}

/** A scheduling deferral, never a provider failure or a consumed retry. */
export class MarketAiDeferredError extends Error {
  constructor(readonly resumeAt: Date) {
    super(
      `Market AI waits for the off-peak window at ${resumeAt.toISOString()}`,
    );
    this.name = "MarketAiDeferredError";
  }
}

export function assertMarketAiWindow(): void {
  const resumeAt = nextMarketAiWindow();
  if (resumeAt) throw new MarketAiDeferredError(resumeAt);
}

/** SDKs and the gateway may wrap a fetch refusal; retain the scheduling reason. */
export function marketAiDeferral(error: unknown): MarketAiDeferredError | null {
  const seen = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    if (current instanceof MarketAiDeferredError) return current;
    seen.add(current);
    current = current.cause;
  }
  return null;
}
