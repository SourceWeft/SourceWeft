import { describe, expect, it } from "vitest";

import {
  skillAggregateRatingJsonLd,
  skillReviewDashboardPath,
  skillReviewHref,
} from "./public-reviews-format";

describe("skillReviewHref", () => {
  it("leads to the dashboard's reviews, through sign-in when signed out", () => {
    expect(skillReviewDashboardPath("pdf tools")).toBe(
      "/dashboard/skills/pdf%20tools#reviews",
    );
    expect(skillReviewHref("pdf", true)).toBe("/dashboard/skills/pdf#reviews");
    expect(skillReviewHref("pdf", false)).toBe(
      "/auth/sign-in?redirectTo=%2Fdashboard%2Fskills%2Fpdf%23reviews",
    );
  });
});

describe("skillAggregateRatingJsonLd", () => {
  const distribution = { "1": 0, "2": 0, "3": 1, "4": 1, "5": 1 };
  it("is present only with at least one review", () => {
    expect(skillAggregateRatingJsonLd(null)).toEqual({});
    expect(skillAggregateRatingJsonLd(undefined)).toEqual({});
    expect(
      skillAggregateRatingJsonLd({
        count: 0,
        average: null,
        distribution: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 },
      }),
    ).toEqual({});
  });

  it("gives the average to one decimal and the count", () => {
    expect(
      skillAggregateRatingJsonLd({ count: 3, average: 4.0333, distribution }),
    ).toEqual({
      aggregateRating: {
        "@type": "AggregateRating",
        ratingValue: 4,
        ratingCount: 3,
        bestRating: 5,
        worstRating: 1,
      },
    });
  });
});
