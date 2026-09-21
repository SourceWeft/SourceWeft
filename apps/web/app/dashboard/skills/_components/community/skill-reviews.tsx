"use client";

import * as React from "react";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { cn } from "@sourceweft/ui-web/lib/utils";
import {
  appendSkillReviews,
  deleteMySkillReview,
  deleteSkillReviewReply,
  isSkillMarketAdminViewer,
  listSkillReviews,
  saveMySkillReview,
  saveSkillReviewReply,
  setSkillReviewStatus,
  SKILL_REVIEW_SORTS,
  skillReviewErrorKind,
  type ListSkillReviewsResponse,
  type SkillReview,
  type SkillReviewSort,
} from "../../../../../lib/skill-reviews";
import { SkillReviewReplyEditor } from "./skill-review-editor";
import { SkillReviewAuthorReply, SkillReviewItem } from "./skill-review-item";
import { SkillReviewOwn } from "./skill-review-own";
import { SkillReviewSummary } from "./skill-review-summary";
import type { DashboardSkillSlotProps } from "./slot-props";

type LoadState =
  | { status: "loading" }
  | { status: "error" }
  // The viewer may not read this skill's reviews: nothing to show.
  | { status: "unavailable" }
  | { status: "ready"; page: ListSkillReviewsResponse };

/** What a failed write says, by why it failed. */
function writeErrorMessage(
  error: unknown,
  fallback: string,
  t: ReturnType<typeof useTranslations>,
) {
  switch (skillReviewErrorKind(error)) {
    case "rate_limited":
      return t("rateLimited");
    case "not_installed":
      return t("notInstalled");
    default:
      return fallback;
  }
}

/**
 * Ratings and reviews on the dashboard skill page (§17.3): the summary, the
 * viewer's own review, the list with sort and "load more", the repository
 * author's replies and a market admin's hide/show. The display parts
 * (summary, stars, one review) are presentational and shared with the public
 * page; everything that calls the API is here.
 */
export function SkillReviews({ slug }: DashboardSkillSlotProps) {
  const t = useTranslations("dashboardSkillReviews");
  const [sort, setSort] = React.useState<SkillReviewSort>("newest");
  const [state, setState] = React.useState<LoadState>({ status: "loading" });
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [isAdmin, setIsAdmin] = React.useState(false);
  // One write at a time: "own", or the id of the review being acted on.
  const [busy, setBusy] = React.useState<string | null>(null);
  const [replyingTo, setReplyingTo] = React.useState<string | null>(null);
  // Guards against an older response landing after a newer request.
  const requestRef = React.useRef(0);

  const load = React.useCallback(
    async (nextSort: SkillReviewSort) => {
      const request = ++requestRef.current;
      try {
        const page = await listSkillReviews(slug, { sort: nextSort });
        if (request === requestRef.current) {
          setState({ status: "ready", page });
        }
      } catch (error) {
        if (request !== requestRef.current) return;
        const kind = skillReviewErrorKind(error);
        setState({
          status:
            kind === "not_found" || kind === "forbidden"
              ? "unavailable"
              : "error",
        });
      }
    },
    [slug],
  );

  React.useEffect(() => {
    setState({ status: "loading" });
    setReplyingTo(null);
    void load(sort);
  }, [load, sort]);

  React.useEffect(() => {
    let active = true;
    void isSkillMarketAdminViewer().then((admin) => {
      if (active) setIsAdmin(admin);
    });
    return () => {
      active = false;
    };
  }, []);

  /** Swaps one review in the shown list, leaving the rest as they are. */
  const replaceReview = (review: SkillReview) =>
    setState((current) =>
      current.status === "ready"
        ? {
            ...current,
            page: {
              ...current.page,
              items: current.page.items.map((item) =>
                item.id === review.id ? review : item,
              ),
            },
          }
        : current,
    );

  /**
   * The summary and the viewer's standing again, without replacing the list
   * — which keeps a review an admin just hid on screen, with "Show".
   */
  const refreshSummary = async () => {
    try {
      const fresh = await listSkillReviews(slug, { sort, limit: 1 });
      setState((current) =>
        current.status === "ready"
          ? {
              ...current,
              page: {
                ...current.page,
                summary: fresh.summary,
                viewer: fresh.viewer,
              },
            }
          : current,
      );
    } catch {
      // The list still shows the change; the numbers catch up on reload.
    }
  };

  const saveOwn = async (input: { rating: number; body: string }) => {
    setBusy("own");
    try {
      await saveMySkillReview(slug, input);
      toast.success(t("saved"));
      await load(sort);
      return true;
    } catch (error) {
      toast.error(writeErrorMessage(error, t("saveFailed"), t));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const deleteOwn = async () => {
    setBusy("own");
    try {
      await deleteMySkillReview(slug);
      toast.success(t("deleted"));
      await load(sort);
      return true;
    } catch (error) {
      toast.error(writeErrorMessage(error, t("deleteFailed"), t));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const saveReply = async (reviewId: string, body: string | null) => {
    setBusy(reviewId);
    try {
      const { review } =
        body === null
          ? await deleteSkillReviewReply(slug, reviewId)
          : await saveSkillReviewReply(slug, reviewId, body);
      replaceReview(review);
      setReplyingTo(null);
      toast.success(body === null ? t("replyDeleted") : t("replySaved"));
    } catch (error) {
      toast.error(writeErrorMessage(error, t("replyFailed"), t));
    } finally {
      setBusy(null);
    }
  };

  const moderate = async (review: SkillReview) => {
    const status = review.status === "hidden" ? "visible" : "hidden";
    setBusy(review.id);
    try {
      await setSkillReviewStatus(review.id, status);
      replaceReview({ ...review, status });
      toast.success(status === "hidden" ? t("hiddenToast") : t("shownToast"));
      await refreshSummary();
    } catch {
      toast.error(t("moderateFailed"));
    } finally {
      setBusy(null);
    }
  };

  const loadMore = async () => {
    if (state.status !== "ready" || !state.page.nextCursor) return;
    const request = requestRef.current;
    setLoadingMore(true);
    try {
      const next = await listSkillReviews(slug, {
        sort,
        cursor: state.page.nextCursor,
      });
      if (request !== requestRef.current) return;
      setState((current) =>
        current.status === "ready"
          ? {
              ...current,
              page: {
                ...current.page,
                items: appendSkillReviews(current.page.items, next.items),
                nextCursor: next.nextCursor,
              },
            }
          : current,
      );
    } catch {
      toast.error(t("loadFailed"));
    } finally {
      setLoadingMore(false);
    }
  };

  if (state.status === "unavailable") return null;

  return (
    <section
      data-testid="skill-reviews"
      aria-labelledby="skill-reviews-heading"
      className="mt-4 rounded-2xl border border-border bg-background p-4 shadow-xs"
    >
      <h2
        id="skill-reviews-heading"
        className="text-sm font-semibold text-foreground"
      >
        {t("heading")}
      </h2>

      {state.status === "loading" ? (
        <div className="flex items-center py-8 text-sm text-muted-foreground">
          <Loader2 className="mr-2 size-4 animate-spin" />
          {t("loading")}
        </div>
      ) : state.status === "error" ? (
        <div className="flex items-center gap-3 py-8 text-sm text-muted-foreground">
          {t("loadFailed")}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setState({ status: "loading" });
              void load(sort);
            }}
          >
            {t("retry")}
          </Button>
        </div>
      ) : (
        <div className="mt-4 flex flex-col gap-4">
          <SkillReviewSummary summary={state.page.summary} />
          <SkillReviewOwn
            viewer={state.page.viewer}
            busy={busy === "own"}
            onSave={saveOwn}
            onDelete={deleteOwn}
          />
          <div
            role="group"
            aria-label={t("sortLabel")}
            className="flex flex-wrap gap-1"
          >
            {SKILL_REVIEW_SORTS.map((option) => (
              <Button
                key={option}
                type="button"
                size="xs"
                variant={option === sort ? "secondary" : "ghost"}
                aria-pressed={option === sort}
                onClick={() => setSort(option)}
              >
                {t(`sorts.${option}`)}
              </Button>
            ))}
          </div>
          {state.page.items.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">
              {t("noReviews")}
            </p>
          ) : (
            <div className="divide-y divide-border">
              {state.page.items.map((review) => {
                const acting = busy === review.id;
                const canReply =
                  state.page.viewer.canReply && review.status === "visible";
                return (
                  <SkillReviewItem
                    key={review.id}
                    review={review}
                    actions={
                      <>
                        {canReply && replyingTo !== review.id ? (
                          <>
                            <Button
                              type="button"
                              variant="ghost"
                              size="xs"
                              disabled={acting}
                              onClick={() => setReplyingTo(review.id)}
                            >
                              {review.authorReply ? t("editReply") : t("reply")}
                            </Button>
                            {review.authorReply ? (
                              <Button
                                type="button"
                                variant="ghost"
                                size="xs"
                                disabled={acting}
                                onClick={() => void saveReply(review.id, null)}
                              >
                                {t("deleteReply")}
                              </Button>
                            ) : null}
                          </>
                        ) : null}
                        {isAdmin ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            disabled={acting}
                            className={cn(
                              review.status === "visible" && "text-destructive",
                            )}
                            onClick={() => void moderate(review)}
                          >
                            {review.status === "hidden" ? (
                              <Eye aria-hidden />
                            ) : (
                              <EyeOff aria-hidden />
                            )}
                            {review.status === "hidden" ? t("show") : t("hide")}
                          </Button>
                        ) : null}
                      </>
                    }
                    reply={
                      replyingTo === review.id ? (
                        <SkillReviewReplyEditor
                          initialBody={review.authorReply?.body ?? ""}
                          busy={acting}
                          onSave={(body) => void saveReply(review.id, body)}
                          onCancel={() => setReplyingTo(null)}
                        />
                      ) : review.authorReply ? (
                        <SkillReviewAuthorReply reply={review.authorReply} />
                      ) : null
                    }
                  />
                );
              })}
            </div>
          )}
          {state.page.nextCursor ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="self-center"
              disabled={loadingMore}
              onClick={() => void loadMore()}
            >
              {loadingMore ? <Loader2 className="animate-spin" /> : null}
              {t("loadMore")}
            </Button>
          ) : null}
        </div>
      )}
    </section>
  );
}
