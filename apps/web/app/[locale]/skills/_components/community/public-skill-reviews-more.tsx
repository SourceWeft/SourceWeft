"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import {
  listSkillReviews,
  type SkillReview,
} from "../../../../../lib/skill-reviews";
import { SkillReviewItem } from "../../../../dashboard/skills/_components/community/skill-review-item";
import { PublicReviewReportLink } from "./public-review-report-link";
import { publicReviewsCopy as copy } from "./public-reviews-copy";

/**
 * "Show more" under the server-rendered first page: later pages load in the
 * browser, from the cursor the server page ended on, and append below it.
 * A review the server already rendered is not shown twice.
 */
export function PublicSkillReviewsMore({
  slug,
  signedIn,
  initialCursor,
  shownIds,
  pageSize,
}: {
  slug: string;
  signedIn: boolean;
  initialCursor: string;
  shownIds: string[];
  pageSize: number;
}) {
  const [items, setItems] = React.useState<SkillReview[]>([]);
  const [cursor, setCursor] = React.useState<string | null>(initialCursor);
  const [loading, setLoading] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  const loadMore = async () => {
    if (!cursor || loading) return;
    setLoading(true);
    setFailed(false);
    try {
      const page = await listSkillReviews(slug, {
        sort: "newest",
        cursor,
        limit: pageSize,
      });
      setItems((current) => {
        const seen = new Set([...shownIds, ...current.map((item) => item.id)]);
        return [...current, ...page.items.filter((item) => !seen.has(item.id))];
      });
      setCursor(page.nextCursor);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      {items.map((review) => (
        <SkillReviewItem
          key={review.id}
          review={review}
          actions={
            <PublicReviewReportLink
              slug={slug}
              reviewId={review.id}
              signedIn={signedIn}
            />
          }
        />
      ))}
      {failed ? (
        <p role="alert" className="py-2 text-sm text-red-700 dark:text-red-400">
          {copy.loadMoreFailed}
        </p>
      ) : null}
      {cursor ? (
        <div className="flex justify-center pt-4">
          <button
            type="button"
            disabled={loading}
            onClick={() => void loadMore()}
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-zinc-300 bg-white px-4 text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-50 disabled:opacity-60 dark:border-white/15 dark:bg-white/5 dark:text-white dark:hover:bg-white/10"
          >
            {loading ? (
              <Loader2 aria-hidden className="size-4 animate-spin" />
            ) : null}
            {copy.showMore}
          </button>
        </div>
      ) : null}
    </>
  );
}
