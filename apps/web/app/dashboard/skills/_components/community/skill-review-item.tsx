import type { ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@sourceweft/ui-web/components/ui/avatar";
import { Badge } from "@sourceweft/ui-web/components/ui/badge";
import { cn } from "@sourceweft/ui-web/lib/utils";
import type { SkillReview } from "../../../../../lib/skill-reviews";
import { formatReviewDate, reviewWasEdited } from "./skill-review-format";
import { SkillReviewStars } from "./skill-review-stars";

function initials(name: string | null): string {
  const letters = (name ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");
  return letters || "?";
}

/**
 * One review: who wrote it, the stars, the text, the version it was about,
 * when, and the author's reply. Presentational — whoever renders it supplies
 * any controls through `actions` (beside the header) and may replace the reply
 * block through `reply` (the dashboard does, to edit it in place).
 */
export function SkillReviewItem({
  review,
  now,
  actions,
  reply,
  className,
}: {
  review: SkillReview;
  /** What "now" is for the relative date; the render time by default. */
  now?: number;
  actions?: ReactNode;
  reply?: ReactNode;
  className?: string;
}) {
  const t = useTranslations("dashboardSkillReviews");
  const locale = useLocale();
  const name = review.reviewer.name ?? t("anonymousReviewer");
  const hidden = review.status === "hidden";
  return (
    <article
      data-testid="skill-review-item"
      data-review-id={review.id}
      className={cn("flex gap-3 py-4", hidden && "opacity-70", className)}
    >
      <Avatar size="sm" className="mt-0.5">
        {review.reviewer.image ? (
          <AvatarImage src={review.reviewer.image} alt="" />
        ) : null}
        <AvatarFallback className="text-[10px]">
          {initials(review.reviewer.name)}
        </AvatarFallback>
      </Avatar>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <header className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium text-foreground">{name}</span>
          <SkillReviewStars rating={review.rating} />
          <span className="text-xs text-muted-foreground">
            <time dateTime={review.createdAt}>
              {formatReviewDate(review.createdAt, now, locale)}
            </time>
            {reviewWasEdited(review) ? ` · ${t("edited")}` : null}
          </span>
          {review.version ? (
            <span className="text-xs text-muted-foreground">
              {t("version", { version: review.version })}
            </span>
          ) : null}
          {hidden ? (
            <Badge variant="secondary">{t("hiddenBadge")}</Badge>
          ) : null}
          {actions ? (
            <span className="ml-auto flex items-center gap-1">{actions}</span>
          ) : null}
        </header>
        {review.body ? (
          <p className="whitespace-pre-line break-words text-sm leading-6 text-foreground">
            {review.body}
          </p>
        ) : null}
        {reply !== undefined ? (
          reply
        ) : review.authorReply ? (
          <SkillReviewAuthorReply
            reply={review.authorReply}
            now={now}
          />
        ) : null}
      </div>
    </article>
  );
}

/** The repository author's answer, set off under the review. */
export function SkillReviewAuthorReply({
  reply,
  now,
}: {
  reply: NonNullable<SkillReview["authorReply"]>;
  now?: number;
}) {
  const t = useTranslations("dashboardSkillReviews");
  const locale = useLocale();
  return (
    <div
      data-testid="skill-review-author-reply"
      className="mt-1 rounded-lg border-l-2 border-primary/40 bg-muted/40 px-3 py-2"
    >
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">
          {t("authorReplyHeading")}
        </span>
        <time dateTime={reply.createdAt}>
          {formatReviewDate(reply.createdAt, now, locale)}
        </time>
      </div>
      <p className="mt-1 whitespace-pre-line break-words text-sm leading-6 text-foreground">
        {reply.body}
      </p>
    </div>
  );
}
