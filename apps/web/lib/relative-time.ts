import {
  differenceInDays,
  differenceInHours,
  differenceInMinutes,
  differenceInMonths,
  differenceInSeconds,
  differenceInWeeks,
  differenceInYears,
} from "date-fns";

export function formatShortRelativeTime(value: Date | string): string {
  const target = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(target.getTime())) {
    return "just now";
  }

  const now = new Date();
  const seconds = differenceInSeconds(now, target);

  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = differenceInMinutes(now, target);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = differenceInHours(now, target);
  if (hours < 24) return `${hours}h ago`;

  const days = differenceInDays(now, target);
  if (days < 7) return `${days}d ago`;

  const weeks = differenceInWeeks(now, target);
  if (weeks < 5) return `${weeks}w ago`;

  const months = differenceInMonths(now, target);
  if (months < 12) return `${Math.max(1, months)}mo ago`;

  const years = differenceInYears(now, target);
  return `${Math.max(1, years)}y ago`;
}
