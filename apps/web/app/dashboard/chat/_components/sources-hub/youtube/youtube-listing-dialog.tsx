"use client";

import { CheckCircle2, CircleAlert, Clock, Loader2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Badge } from "@sourceweft/ui-web/components/ui/badge";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { Checkbox } from "@sourceweft/ui-web/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@sourceweft/ui-web/components/ui/dialog";

import { RawImage } from "../../../../../_components/raw-image";
import { formatDisplayDate } from "@/lib/i18n/format";
import { formatClock, formatWait } from "../discovery/rate-limit-notice";
import { useYouTubeListing } from "./use-youtube-listing";

/**
 * Picks videos from a YouTube playlist or channel link and imports each as
 * its own source. Open while `url` is set.
 */
export function YouTubeListingDialog({
  onImported,
  onOpenChange,
  parentSourceId,
  url,
  workspaceId,
}: {
  onImported: () => void;
  onOpenChange: (open: boolean) => void;
  parentSourceId: string | null;
  url: string | null;
  workspaceId: string;
}) {
  const t = useTranslations("dashboardSourcesHub");
  const locale = useLocale();
  const state = useYouTubeListing({
    onImported,
    parentSourceId,
    url,
    workspaceId,
  });
  const { listing, outcomes, phase, selected } = state;

  const outcomeList = [...outcomes.values()];
  const added = outcomeList.filter(
    (item) => item.kind === "indexed" || item.kind === "pending",
  ).length;
  const failed = outcomeList.filter((item) => item.kind === "failed").length;
  const skipped = outcomeList.filter((item) => item.kind === "quota").length;

  // Until the listing has loaded there is nothing to describe yet; the
  // transcript and cost notes belong next to the videos they apply to.
  const subtitle = listing
    ? [
        listing.kind === "playlist"
          ? t("youtube.playlist")
          : t("youtube.channel"),
        listing.channelTitle
          ? t("youtube.byChannel", { channel: listing.channelTitle })
          : null,
        t("youtube.videoCount", { count: listing.videos.length }),
      ]
        .filter(Boolean)
        .join(" · ")
    : null;

  return (
    <Dialog onOpenChange={onOpenChange} open={url !== null}>
      <DialogContent className="flex max-h-[85vh] min-w-0 flex-col gap-3 overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="truncate">
            {listing?.title || t("youtube.dialogTitle")}
          </DialogTitle>
          {subtitle ? (
            <DialogDescription>{subtitle}</DialogDescription>
          ) : (
            <DialogDescription className="sr-only">
              {t("youtube.chooseVideos")}
            </DialogDescription>
          )}
        </DialogHeader>

        {phase === "loading" ? (
          <p className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t("youtube.loading")}
          </p>
        ) : phase === "error" ? (
          <div className="space-y-3 py-2">
            {state.limit ? (
              <div
                className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300"
                data-rate-limit-notice
                role="status"
              >
                {t("youtube.rateLimited", {
                  wait: formatWait(state.secondsLeft, locale),
                  time: formatClock(state.limit.until, locale),
                })}
              </div>
            ) : state.error ? (
              <p className="text-sm text-destructive" role="alert">
                {state.error}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button
                onClick={() => onOpenChange(false)}
                size="sm"
                type="button"
                variant="outline"
              >
                {t("discovery.close")}
              </Button>
              <Button
                disabled={state.limit !== null}
                onClick={state.retry}
                size="sm"
                type="button"
              >
                {t("youtube.retry")}
              </Button>
            </div>
          </div>
        ) : listing ? (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
            {listing.videos.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {t("youtube.empty")}
              </p>
            ) : (
              <ul className="min-h-0 min-w-0 flex-1 space-y-1 overflow-y-auto pr-1">
                {listing.videos.map((video) => {
                  const outcome = outcomes.get(video.url);
                  const existing = video.existingSourceId !== null;
                  return (
                    <li
                      className="flex items-start gap-3 rounded-lg border px-3 py-2"
                      data-youtube-video={video.videoId}
                      key={video.videoId}
                    >
                      <Checkbox
                        aria-label={video.title}
                        checked={existing ? false : selected.has(video.url)}
                        className="mt-1"
                        disabled={existing || phase !== "ready"}
                        onCheckedChange={() => state.toggle(video.url)}
                      />
                      {video.thumbnailUrl ? (
                        <RawImage
                          alt=""
                          className="aspect-video w-24 shrink-0 rounded-md bg-muted object-cover"
                          loading="lazy"
                          referrerPolicy="no-referrer"
                          src={video.thumbnailUrl}
                        />
                      ) : (
                        <div className="aspect-video w-24 shrink-0 rounded-md bg-muted" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="line-clamp-2 text-sm font-medium">
                            {video.title}
                          </span>
                          {existing ? (
                            <Badge className="shrink-0" variant="outline">
                              {t("discovery.alreadyAdded")}
                            </Badge>
                          ) : null}
                        </div>
                        {video.publishedAt ? (
                          <div className="text-xs text-muted-foreground">
                            {formatDisplayDate(
                              new Date(video.publishedAt),
                              locale,
                              {
                                year: "numeric",
                                month: "short",
                                day: "numeric",
                              },
                            )}
                          </div>
                        ) : null}
                        {outcome?.kind === "failed" ? (
                          <p className="mt-1 text-xs text-destructive">
                            {outcome.message}
                          </p>
                        ) : null}
                        {outcome?.kind === "quota" ? (
                          <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                            {t("discovery.notImportedQuota")}
                          </p>
                        ) : null}
                      </div>
                      <div className="mt-1 shrink-0">
                        {outcome?.kind === "indexed" ? (
                          <CheckCircle2 className="size-4 text-emerald-500" />
                        ) : outcome?.kind === "failed" ? (
                          <CircleAlert className="size-4 text-destructive" />
                        ) : outcome?.kind === "quota" ? (
                          <CircleAlert className="size-4 text-amber-500" />
                        ) : outcome?.kind === "pending" ? (
                          <Clock className="size-4 text-muted-foreground" />
                        ) : phase === "importing" && selected.has(video.url) ? (
                          <Loader2 className="size-4 animate-spin text-muted-foreground" />
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            {phase === "done" ? (
              <p className="text-sm" data-import-summary>
                {t("discovery.summary", { added, failed, skipped })}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                {t("youtube.transcriptNote")} {t("youtube.costNote")}
              </p>
            )}

            <div className="flex items-center justify-between gap-2">
              <Button
                disabled={phase !== "ready" || state.selectable.length === 0}
                onClick={state.toggleAll}
                size="sm"
                type="button"
                variant="ghost"
              >
                {state.allSelected
                  ? t("discovery.selectNone")
                  : t("discovery.selectAll")}
              </Button>
              {phase !== "done" ? (
                <Button
                  disabled={phase !== "ready" || selected.size === 0}
                  onClick={() => void state.runImport()}
                  size="sm"
                  type="button"
                >
                  {phase === "importing" ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : null}
                  {t("youtube.import", { count: selected.size })}
                </Button>
              ) : (
                <Button
                  onClick={() => onOpenChange(false)}
                  size="sm"
                  type="button"
                >
                  {t("discovery.close")}
                </Button>
              )}
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
