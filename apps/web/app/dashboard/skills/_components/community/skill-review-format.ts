import type { SkillReviewSummary } from "../../../../../lib/skill-reviews";

/** Pure helpers behind the review display, shared with the public page. */

export const SKILL_REVIEW_STARS = [5, 4, 3, 2, 1] as const;

/** The average to one decimal ("4.3"); an em dash while there is none. */
export function formatReviewAverage(average: number | null): string {
  return average === null ? "—" : (Math.round(average * 10) / 10).toFixed(1);
}

/** Share of reviews at `stars`, as a whole percent for a bar's width. */
export function reviewDistributionPercent(
  summary: SkillReviewSummary,
  stars: 1 | 2 | 3 | 4 | 5,
): number {
  if (summary.count === 0) return 0;
  return Math.round((summary.distribution[stars] / summary.count) * 100);
}

/** How much of each of five stars is filled for a rating: 1, 0.5 or 0. */
export function starFills(rating: number): number[] {
  // Rounded to the half star, so 4.3 shows four and a half.
  const halves = Math.round(Math.min(5, Math.max(0, rating)) * 2);
  return [0, 1, 2, 3, 4].map((index) =>
    Math.min(1, Math.max(0, (halves - index * 2) / 2)),
  );
}

const RELATIVE_UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 24 * 60 * 60],
  ["month", 30 * 24 * 60 * 60],
  ["week", 7 * 24 * 60 * 60],
  ["day", 24 * 60 * 60],
  ["hour", 60 * 60],
  ["minute", 60],
];

/**
 * "3 days ago", "last month", "now". `now` is a parameter so a render and a
 * test agree on what "now" is; an unparsable date is shown as nothing.
 */
export function formatReviewDate(
  iso: string,
  now: number = Date.now(),
  locale = "en",
): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "";
  const seconds = Math.round((time - now) / 1000);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  for (const [unit, size] of RELATIVE_UNITS) {
    if (Math.abs(seconds) >= size) {
      return format.format(Math.trunc(seconds / size), unit);
    }
  }
  return format.format(0, "second");
}

/** The review was changed after it was first written (by a minute or more). */
export function reviewWasEdited(review: {
  createdAt: string;
  updatedAt: string;
}): boolean {
  return Date.parse(review.updatedAt) - Date.parse(review.createdAt) >= 60_000;
}
