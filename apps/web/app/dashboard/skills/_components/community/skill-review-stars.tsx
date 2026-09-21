import { Star } from "lucide-react";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { starFills } from "./skill-review-format";
import { skillReviewsCopy, type SkillReviewsCopy } from "./skill-reviews-copy";

/**
 * A rating as five stars, filled to the half star. Presentational: no state,
 * no fetch, so the public page can render it on the server.
 */
export function SkillReviewStars({
  rating,
  size = "sm",
  className,
  copy = skillReviewsCopy,
}: {
  rating: number;
  size?: "sm" | "md";
  className?: string;
  copy?: Pick<SkillReviewsCopy, "starsLabel">;
}) {
  const iconSize = size === "md" ? "size-5" : "size-3.5";
  return (
    <span
      role="img"
      aria-label={copy.starsLabel(Math.round(rating * 10) / 10)}
      className={cn("inline-flex items-center gap-0.5", className)}
    >
      {starFills(rating).map((fill, index) => (
        <span key={index} className={cn("relative inline-flex", iconSize)}>
          <Star
            aria-hidden
            className={cn(iconSize, "text-muted-foreground/40")}
          />
          {fill > 0 ? (
            <span
              className="absolute inset-y-0 left-0 overflow-hidden"
              style={{ width: `${fill * 100}%` }}
            >
              <Star
                aria-hidden
                className={cn(iconSize, "fill-amber-400 text-amber-400")}
              />
            </span>
          ) : null}
        </span>
      ))}
    </span>
  );
}

/** Five buttons to pick a rating; a radio group to assistive technology. */
export function SkillReviewStarPicker({
  value,
  onChange,
  disabled,
  copy = skillReviewsCopy,
}: {
  value: number;
  onChange: (rating: number) => void;
  disabled?: boolean;
  copy?: Pick<SkillReviewsCopy, "starsLabel" | "ratingPickerLabel">;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={copy.ratingPickerLabel}
      className="inline-flex items-center gap-1"
    >
      {[1, 2, 3, 4, 5].map((rating) => (
        <button
          key={rating}
          type="button"
          role="radio"
          aria-checked={value === rating}
          aria-label={copy.starsLabel(rating)}
          disabled={disabled}
          onClick={() => onChange(rating)}
          className="rounded-md p-0.5 outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
        >
          <Star
            aria-hidden
            className={cn(
              "size-6",
              rating <= value
                ? "fill-amber-400 text-amber-400"
                : "text-muted-foreground/50",
            )}
          />
        </button>
      ))}
    </div>
  );
}
