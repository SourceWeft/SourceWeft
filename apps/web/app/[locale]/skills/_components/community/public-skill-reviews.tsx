import Link from "next/link";
import { PenLine } from "lucide-react";
import {
  getPublicSkillReviews,
  PUBLIC_SKILL_REVIEWS_PAGE_SIZE,
} from "../../../../../lib/public-skill-reviews";
import { SkillReviewItem } from "../../../../dashboard/skills/_components/community/skill-review-item";
import { SkillReviewSummary } from "../../../../dashboard/skills/_components/community/skill-review-summary";
import { skillsContainerClassName } from "../skills-format";
import { PublicReviewReportLink } from "./public-review-report-link";
import { publicReviewsCopy as copy } from "./public-reviews-copy";
import { skillReviewHref } from "./public-reviews-format";
import { PublicSkillReviewsMore } from "./public-skill-reviews-more";
import type { PublicSkillSlotProps } from "./slot-props";

/**
 * Ratings and reviews below the page body (§17.3). Rendered on the server
 * from the anonymous first page, so the reviews are in the HTML; later pages
 * load in the browser. Writing happens in the dashboard, which the call to
 * action leads to. With no reviews yet: only that call to action for someone
 * signed in, and nothing at all for a visitor.
 */
export async function PublicSkillReviews({
  slug,
  signedIn,
}: PublicSkillSlotProps) {
  const reviews = await getPublicSkillReviews(slug);
  if (!reviews) return null;
  const hasReviews = reviews.summary.count > 0 && reviews.items.length > 0;
  if (!hasReviews && !signedIn) return null;
  const now = Date.now();

  return (
    <section
      id="reviews"
      data-testid="public-skill-reviews"
      aria-labelledby="public-skill-reviews-heading"
      className={`mx-auto pb-12 ${skillsContainerClassName}`}
    >
      <div className="rounded-2xl border border-zinc-300 bg-white/70 p-5 dark:border-white/10 dark:bg-white/5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2
            id="public-skill-reviews-heading"
            className="text-base font-semibold text-zinc-950 dark:text-white"
          >
            {copy.heading}
          </h2>
          <Link
            href={skillReviewHref(slug, signedIn)}
            data-testid="public-skill-reviews-cta"
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-zinc-950 px-3 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-100"
          >
            <PenLine aria-hidden className="size-4" />
            {signedIn ? copy.writeReview : copy.signInToReview}
          </Link>
        </div>

        {hasReviews ? (
          <>
            <div className="mt-5">
              <SkillReviewSummary summary={reviews.summary} />
            </div>
            <div className="mt-5 divide-y divide-zinc-200 dark:divide-white/10">
              {reviews.items.map((review) => (
                <SkillReviewItem
                  key={review.id}
                  review={review}
                  now={now}
                  actions={
                    <PublicReviewReportLink
                      slug={slug}
                      reviewId={review.id}
                      signedIn={signedIn}
                    />
                  }
                />
              ))}
              {reviews.nextCursor ? (
                <PublicSkillReviewsMore
                  slug={slug}
                  signedIn={signedIn}
                  initialCursor={reviews.nextCursor}
                  shownIds={reviews.items.map((review) => review.id)}
                  pageSize={PUBLIC_SKILL_REVIEWS_PAGE_SIZE}
                />
              ) : null}
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}
