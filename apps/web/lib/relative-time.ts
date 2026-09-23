import { isLocale } from "@sourceweft/i18n/locales";

export function formatShortRelativeTime(
  value: Date | string,
  locale = "en",
  now = new Date(),
): string {
  const target = value instanceof Date ? value : new Date(value);
  const formatter = new Intl.RelativeTimeFormat(
    isLocale(locale) ? locale : "en",
    { numeric: "auto", style: "short" },
  );
  const seconds = (target.getTime() - now.getTime()) / 1000;
  if (!Number.isFinite(seconds) || Math.abs(seconds) < 5)
    return formatter.format(0, "second");
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31536000],
    ["month", 2592000],
    ["week", 604800],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
    ["second", 1],
  ];
  const [unit, size] = units.find(([, size]) => Math.abs(seconds) >= size)!;
  return formatter.format(Math.trunc(seconds / size), unit);
}
