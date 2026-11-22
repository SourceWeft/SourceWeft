"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import type {
  YouTubeListingResponse,
  YouTubeSourceErrorCode,
} from "@sourceweft/contracts/sources";
import { HttpClientError } from "@sourceweft/sdk";

import { contentClient } from "../../../../../../lib/sdk";
import {
  importCandidates,
  type ImportOutcome,
} from "../discovery/import-candidates";
import {
  parseRateLimit,
  type RateLimitNotice,
} from "../discovery/rate-limit-notice";
import { asYouTubeErrorCode, youTubeErrorCodeOf } from "./errors";

export type YouTubeListingPhase =
  "loading" | "error" | "ready" | "importing" | "done";

/**
 * Loads the videos of a playlist or channel link, keeps which ones are
 * chosen, and imports them with the discovery import (a few at a time, with
 * status polling, stopping once ingestion pages run out). `url` is null
 * while the dialog is closed; closing resets everything.
 */
export function useYouTubeListing({
  onImported,
  parentSourceId,
  url,
  workspaceId,
}: {
  onImported: () => void;
  parentSourceId: string | null;
  url: string | null;
  workspaceId: string;
}) {
  const t = useTranslations("dashboardSourcesHub");
  const [phase, setPhase] = useState<YouTubeListingPhase>("loading");
  const [listing, setListing] = useState<YouTubeListingResponse | null>(null);
  /** Why the listing failed: a YouTube code, or the limiter being down. */
  const [error, setError] = useState<YouTubeSourceErrorCode | "busy" | null>(
    null,
  );
  const [limit, setLimit] = useState<RateLimitNotice | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [attempt, setAttempt] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [outcomes, setOutcomes] = useState<Map<string, ImportOutcome>>(
    () => new Map(),
  );

  const describe = useCallback(
    (code: unknown, fallback: string) => {
      const known = asYouTubeErrorCode(code);
      return known ? t(`youtube.error.${known}`) : fallback;
    },
    [t],
  );

  useEffect(() => {
    setListing(null);
    setError(null);
    setLimit(null);
    setSelected(new Set());
    setOutcomes(new Map());
    setPhase("loading");
    if (!url) return;

    let cancelled = false;
    contentClient
      .listYouTubeCollection(workspaceId, { url })
      .then((result) => {
        if (cancelled) return;
        setListing(result);
        setPhase("ready");
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setPhase("error");
        const notice = parseRateLimit(caught, Date.now());
        if (notice) {
          setNow(Date.now());
          setLimit(notice);
          return;
        }
        setError(
          caught instanceof HttpClientError &&
            caught.code === "RATE_LIMIT_UNAVAILABLE"
            ? "busy"
            : (youTubeErrorCodeOf(caught) ?? "YOUTUBE_LISTING_FAILED"),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [attempt, url, workspaceId]);

  // While a limit is showing, count down and lift it by itself when it clears.
  useEffect(() => {
    if (!limit) return;
    const tick = () => {
      const current = Date.now();
      setNow(current);
      if (current >= limit.until) setLimit(null);
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [limit]);

  const secondsLeft = limit
    ? Math.max(0, Math.ceil((limit.until - now) / 1000))
    : 0;

  const selectable = useMemo(
    () =>
      listing?.videos.filter((video) => video.existingSourceId === null) ?? [],
    [listing],
  );
  const allSelected =
    selectable.length > 0 &&
    selectable.every((video) => selected.has(video.url));

  const toggle = (videoUrl: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(videoUrl)) next.delete(videoUrl);
      else next.add(videoUrl);
      return next;
    });

  const toggleAll = () =>
    setSelected(
      allSelected ? new Set() : new Set(selectable.map((video) => video.url)),
    );

  const retry = () => setAttempt((value) => value + 1);

  const runImport = async () => {
    const urls = selectable
      .filter((video) => selected.has(video.url))
      .map((video) => video.url);
    if (urls.length === 0) return;
    setOutcomes(new Map());
    setPhase("importing");
    const results = await importCandidates({
      urls,
      create: async (videoUrl) => {
        try {
          const created = await contentClient.createUrlSource(workspaceId, {
            url: videoUrl,
            parentSourceId,
          });
          return { id: created.source.id };
        } catch (caught) {
          // Anything else (the ingestion-page refusal above all, whose code
          // stops the remaining waves) reaches importCandidates unchanged.
          const code = youTubeErrorCodeOf(caught);
          if (!code) throw caught;
          throw new Error(t(`youtube.error.${code}`));
        }
      },
      statuses: async (ids) => {
        const response = await contentClient.listSourceStatuses(workspaceId, {
          ids,
        });
        return response.items.map((item) => ({
          id: item.id,
          status: item.status.status,
          error:
            describe(item.status.errorCode, item.status.error ?? "") || null,
          errorCode: item.status.errorCode ?? null,
        }));
      },
      onOutcome: (outcome) =>
        setOutcomes((current) => new Map(current).set(outcome.url, outcome)),
    });
    setPhase("done");
    onImported();
    const added = results.filter(
      (item) => item.kind === "indexed" || item.kind === "pending",
    ).length;
    if (added > 0) toast.success(t("youtube.imported", { count: added }));
  };

  return {
    allSelected,
    error:
      error === null
        ? null
        : error === "busy"
          ? t("youtube.errorBusy")
          : t(`youtube.error.${error}`),
    limit: limit && secondsLeft > 0 ? limit : null,
    listing,
    outcomes,
    phase,
    retry,
    runImport,
    secondsLeft,
    selectable,
    selected,
    toggle,
    toggleAll,
  };
}
