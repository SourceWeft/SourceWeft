import type { SkillReviewSummary } from "@sourceweft/contracts";

/** Where writing a review happens: the dashboard's reviews section. */
export function skillReviewDashboardPath(slug: string): string {
  return `/dashboard/skills/${encodeURIComponent(slug)}#reviews`;
}

/** The review CTA: the dashboard, or sign-in on the way there. */
export function skillReviewHref(slug: string, signedIn: boolean): string {
  const target = skillReviewDashboardPath(slug);
  return signedIn
    ? target
    : `/auth/sign-in?redirectTo=${encodeURIComponent(target)}`;
}

/**
 * schema.org `aggregateRating` for the page's JSON-LD, spread into its
 * `SoftwareSourceCode` object; empty with no visible review, since a rating
 * of nothing is not structured data a search engine accepts.
 */
export function skillAggregateRatingJsonLd(
  summary: SkillReviewSummary | null | undefined,
): { aggregateRating?: Record<string, unknown> } {
  if (!summary || summary.count < 1 || summary.average === null) return {};
  return {
    aggregateRating: {
      "@type": "AggregateRating",
      ratingValue: Math.round(summary.average * 10) / 10,
      ratingCount: summary.count,
      bestRating: 5,
      worstRating: 1,
    },
  };
}
