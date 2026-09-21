import { describe, expect, it } from "vitest";

import {
  formatReviewAverage,
  formatReviewDate,
  reviewDistributionPercent,
  reviewWasEdited,
  starFills,
} from "./skill-review-format";

const summary = {
  count: 8,
  average: 3.875,
  distribution: { "1": 1, "2": 0, "3": 2, "4": 1, "5": 4 },
};

describe("formatReviewAverage", () => {
  it("shows one decimal, and a dash while there is no rating", () => {
    expect(formatReviewAverage(3.875)).toBe("3.9");
    expect(formatReviewAverage(4)).toBe("4.0");
    expect(formatReviewAverage(4.25)).toBe("4.3");
    expect(formatReviewAverage(null)).toBe("—");
  });
});

describe("reviewDistributionPercent", () => {
  it("is each star's share, and 0 with no reviews", () => {
    expect(reviewDistributionPercent(summary, 5)).toBe(50);
    expect(reviewDistributionPercent(summary, 2)).toBe(0);
    expect(reviewDistributionPercent(summary, 3)).toBe(25);
    expect(
      reviewDistributionPercent(
        { ...summary, count: 0, distribution: { ...summary.distribution } },
        5,
      ),
    ).toBe(0);
  });
});

describe("starFills", () => {
  it("fills to the nearest half star, within 0..5", () => {
    expect(starFills(5)).toEqual([1, 1, 1, 1, 1]);
    expect(starFills(4.3)).toEqual([1, 1, 1, 1, 0.5]);
    expect(starFills(4.2)).toEqual([1, 1, 1, 1, 0]);
    expect(starFills(0)).toEqual([0, 0, 0, 0, 0]);
    expect(starFills(9)).toEqual([1, 1, 1, 1, 1]);
    expect(starFills(-1)).toEqual([0, 0, 0, 0, 0]);
  });
});

describe("formatReviewDate", () => {
  const now = Date.parse("2026-09-22T12:00:00.000Z");
  it("says how long ago, in the largest unit that fits", () => {
    expect(formatReviewDate("2026-09-22T11:59:40.000Z", now)).toBe("now");
    expect(formatReviewDate("2026-09-22T11:55:00.000Z", now)).toBe(
      "5 minutes ago",
    );
    expect(formatReviewDate("2026-09-21T12:00:00.000Z", now)).toBe("yesterday");
    expect(formatReviewDate("2026-09-01T12:00:00.000Z", now)).toBe(
      "3 weeks ago",
    );
    expect(formatReviewDate("2025-09-01T12:00:00.000Z", now)).toBe("last year");
  });

  it("shows nothing for a date it cannot read", () => {
    expect(formatReviewDate("not a date", now)).toBe("");
  });
});

describe("reviewWasEdited", () => {
  it("only when changed a minute or more after it was written", () => {
    expect(
      reviewWasEdited({
        createdAt: "2026-09-22T00:00:00.000Z",
        updatedAt: "2026-09-22T00:00:30.000Z",
      }),
    ).toBe(false);
    expect(
      reviewWasEdited({
        createdAt: "2026-09-22T00:00:00.000Z",
        updatedAt: "2026-09-23T00:00:00.000Z",
      }),
    ).toBe(true);
  });
});
