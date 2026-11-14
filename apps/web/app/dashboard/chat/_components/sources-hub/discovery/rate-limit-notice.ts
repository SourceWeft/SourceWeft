import { HttpClientError } from "@sourceweft/sdk";
import type { SourceDiscoveryRateLimitDetails } from "@sourceweft/contracts/sources";

export type RateLimitNotice = {
  scope: SourceDiscoveryRateLimitDetails["scope"];
  /** When the refusing window clears, epoch milliseconds. */
  until: number;
};

const SCOPES = new Set(["minute", "hour", "day", "team"]);

/** The notice for a refused discovery request, or null for any other error. */
export function parseRateLimit(
  error: unknown,
  now: number,
): RateLimitNotice | null {
  if (
    !(error instanceof HttpClientError) ||
    error.status !== 429 ||
    error.code !== "SOURCE_DISCOVERY_RATE_LIMITED"
  ) {
    return null;
  }
  const details = (error.details ??
    {}) as Partial<SourceDiscoveryRateLimitDetails>;
  const seconds =
    typeof details.retryAfterSeconds === "number" &&
    details.retryAfterSeconds > 0
      ? details.retryAfterSeconds
      : 60;
  const scope = SCOPES.has(String(details.scope))
    ? (details.scope as RateLimitNotice["scope"])
    : "minute";
  return { scope, until: now + seconds * 1000 };
}

/** "42 s", "5 min", "1 h 5 min", in the reader's language. */
export function formatWait(seconds: number, locale: string) {
  const unit = (value: number, name: "second" | "minute" | "hour") =>
    new Intl.NumberFormat(locale, {
      style: "unit",
      unit: name,
      unitDisplay: "narrow",
    }).format(value);
  const total = Math.max(1, Math.ceil(seconds));
  if (total < 90) return unit(total, "second");
  const minutes = Math.ceil(total / 60);
  if (minutes < 60) return unit(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0
    ? unit(hours, "hour")
    : `${unit(hours, "hour")} ${unit(rest, "minute")}`;
}

/** The local clock time a limit clears, e.g. "3:42 PM". */
export function formatClock(epochMs: number, locale: string) {
  return new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(epochMs));
}

/** "12 minutes ago" for a cached answer. */
export function formatAgo(iso: string, now: number, locale: string) {
  const seconds = Math.max(
    0,
    Math.round((now - new Date(iso).getTime()) / 1000),
  );
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (seconds < 60) return formatter.format(0, "second");
  if (seconds < 3600)
    return formatter.format(-Math.round(seconds / 60), "minute");
  return formatter.format(-Math.round(seconds / 3600), "hour");
}
