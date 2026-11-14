"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  CircleAlert,
  Clock,
  Loader2,
  Search,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import type { SourceDiscoveryCandidate } from "@sourceweft/contracts/sources";
import { HttpClientError } from "@sourceweft/sdk";
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
import { Input } from "@sourceweft/ui-web/components/ui/input";
import { contentClient } from "../../../../../../lib/sdk";
import { importCandidates, type ImportOutcome } from "./import-candidates";
import {
  formatAgo,
  formatClock,
  formatWait,
  parseRateLimit,
  type RateLimitNotice,
} from "./rate-limit-notice";

type Phase = "search" | "searching" | "results" | "importing" | "done";

/** Whether this deployment can discover sources; the entry point is hidden without it. */
export function useSourceDiscoveryAvailable(workspaceId?: string | null) {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    if (!workspaceId) {
      setAvailable(false);
      return;
    }
    let cancelled = false;
    contentClient
      .getSourceDiscoveryAvailability(workspaceId)
      .then((result) => {
        if (!cancelled) setAvailable(result.available);
      })
      .catch(() => {
        if (!cancelled) setAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);
  return available;
}

export function SourceDiscoveryDialog({
  onImported,
  onOpenChange,
  open,
  workspaceId,
}: {
  onImported: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  workspaceId: string;
}) {
  const t = useTranslations("dashboardSourcesHub");
  const locale = useLocale();
  const [phase, setPhase] = useState<Phase>("search");
  const [topic, setTopic] = useState("");
  const [queries, setQueries] = useState<string[]>([]);
  const [candidates, setCandidates] = useState<SourceDiscoveryCandidate[]>([]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [outcomes, setOutcomes] = useState<Map<string, ImportOutcome>>(
    () => new Map(),
  );
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState<RateLimitNotice | null>(null);
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

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

  useEffect(() => {
    if (open) return;
    setPhase("search");
    setTopic("");
    setQueries([]);
    setCandidates([]);
    setSelected(new Set());
    setOutcomes(new Map());
    setError(null);
    setLimit(null);
    setCachedAt(null);
  }, [open]);

  const secondsLeft = limit
    ? Math.max(0, Math.ceil((limit.until - now) / 1000))
    : 0;
  const limited = limit !== null && secondsLeft > 0;

  const selectable = useMemo(
    () => candidates.filter((item) => item.existingSourceId === null),
    [candidates],
  );

  const search = async () => {
    const value = topic.trim();
    if (value.length < 3) return;
    setPhase("searching");
    setError(null);
    try {
      const result = await contentClient.discoverSources(workspaceId, value);
      setQueries(result.queries);
      setCandidates(result.candidates);
      setCachedAt(result.cached ? result.cachedAt : null);
      setSelected(new Set());
      setLimit(null);
      setPhase("results");
    } catch (caught) {
      setPhase("search");
      const notice = parseRateLimit(caught, Date.now());
      if (notice) {
        // Not an error to dismiss: say which limit it was and when it clears,
        // and leave the topic and any earlier results where they are.
        setNow(Date.now());
        setLimit(notice);
        return;
      }
      setError(
        caught instanceof HttpClientError && caught.status === 402
          ? t("discovery.errorCredits")
          : caught instanceof HttpClientError &&
              caught.code === "RATE_LIMIT_UNAVAILABLE"
            ? t("discovery.errorBusy")
            : caught instanceof HttpClientError && caught.status === 503
              ? t("discovery.errorUnavailable")
              : t("discovery.errorSearch"),
      );
    }
  };

  const toggle = (url: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });

  const allSelected =
    selectable.length > 0 && selectable.every((item) => selected.has(item.url));

  const runImport = async () => {
    const urls = candidates
      .filter((item) => selected.has(item.url))
      .map((item) => item.url);
    if (urls.length === 0) return;
    setOutcomes(new Map());
    setPhase("importing");
    const results = await importCandidates({
      urls,
      create: async (url) => {
        const created = await contentClient.createUrlSource(workspaceId, {
          url,
        });
        return { id: created.source.id };
      },
      statuses: async (ids) => {
        const response = await contentClient.listSourceStatuses(workspaceId, {
          ids,
        });
        return response.items.map((item) => ({
          id: item.id,
          status: item.status.status,
          error: item.status.error,
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
    if (added > 0) toast.success(t("discovery.imported", { count: added }));
  };

  const outcomeOf = (url: string) => outcomes.get(url);
  const failedOutcomes = [...outcomes.values()].filter(
    (item) => item.kind === "failed",
  );
  const quotaOutcomes = [...outcomes.values()].filter(
    (item) => item.kind === "quota",
  );
  const addedCount = [...outcomes.values()].filter(
    (item) => item.kind === "indexed" || item.kind === "pending",
  ).length;

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="flex max-h-[85vh] min-w-0 flex-col gap-3 overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("discovery.title")}</DialogTitle>
          <DialogDescription>{t("discovery.description")}</DialogDescription>
        </DialogHeader>

        {phase === "search" || phase === "searching" ? (
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void search();
            }}
          >
            <div className="flex gap-2">
              <Input
                autoFocus
                disabled={phase === "searching"}
                maxLength={500}
                onChange={(event) => setTopic(event.target.value)}
                placeholder={t("discovery.topicPlaceholder")}
                value={topic}
              />
              <Button
                disabled={
                  phase === "searching" || limited || topic.trim().length < 3
                }
                type="submit"
              >
                {phase === "searching" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Search className="size-4" />
                )}
                {phase === "searching"
                  ? t("discovery.searching")
                  : limited
                    ? t("discovery.tryAgainIn", {
                        wait: formatWait(secondsLeft, locale),
                      })
                    : t("discovery.search")}
              </Button>
            </div>
            {limited && limit ? (
              <div
                className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300"
                data-rate-limit-notice
                role="status"
              >
                {t(`discovery.rateLimit.${limit.scope}`, {
                  wait: formatWait(secondsLeft, locale),
                  time: formatClock(limit.until, locale),
                })}
                <span className="mt-1 block text-xs opacity-80">
                  {t("discovery.rateLimitHint")}
                </span>
              </div>
            ) : null}
            {candidates.length > 0 ? (
              <Button
                onClick={() => setPhase("results")}
                size="sm"
                type="button"
                variant="ghost"
              >
                {t("discovery.backToResults", { count: candidates.length })}
              </Button>
            ) : null}
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <p className="text-xs text-muted-foreground">
              {t("discovery.costNote")}
            </p>
          </form>
        ) : (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
            {queries.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <span>{t("discovery.searched")}</span>
                {queries.map((query) => (
                  <Badge key={query} variant="secondary">
                    {query}
                  </Badge>
                ))}
              </div>
            ) : null}

            {cachedAt ? (
              <p className="text-xs text-muted-foreground" data-cached-note>
                {t("discovery.cachedNote", {
                  ago: formatAgo(cachedAt, now, locale),
                })}
              </p>
            ) : null}

            {candidates.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {t("discovery.empty")}
              </p>
            ) : (
              <ul className="min-h-0 min-w-0 flex-1 space-y-1 overflow-y-auto pr-1">
                {candidates.map((item) => {
                  const outcome = outcomeOf(item.url);
                  const existing = item.existingSourceId !== null;
                  return (
                    <li
                      className="flex items-start gap-3 rounded-lg border px-3 py-2"
                      data-candidate={item.url}
                      key={item.url}
                    >
                      <Checkbox
                        aria-label={item.title}
                        checked={existing ? false : selected.has(item.url)}
                        className="mt-1"
                        disabled={existing || phase !== "results"}
                        onCheckedChange={() => toggle(item.url)}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">
                            {item.title}
                          </span>
                          {existing ? (
                            <Badge variant="outline">
                              {t("discovery.alreadyAdded")}
                            </Badge>
                          ) : null}
                        </div>
                        <div className="truncate text-xs text-muted-foreground">
                          {item.domain}
                        </div>
                        {item.snippet ? (
                          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                            {item.snippet}
                          </p>
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
                        ) : phase === "importing" && selected.has(item.url) ? (
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
                {t("discovery.summary", {
                  added: addedCount,
                  failed: failedOutcomes.length,
                  skipped: quotaOutcomes.length,
                })}
              </p>
            ) : null}

            <div className="flex items-center justify-between gap-2">
              <Button
                disabled={phase !== "results" || selectable.length === 0}
                onClick={() =>
                  setSelected(
                    allSelected
                      ? new Set()
                      : new Set(selectable.map((item) => item.url)),
                  )
                }
                size="sm"
                type="button"
                variant="ghost"
              >
                {allSelected
                  ? t("discovery.selectNone")
                  : t("discovery.selectAll")}
              </Button>
              <div className="flex gap-2">
                {phase === "results" || phase === "done" ? (
                  <Button
                    onClick={() => {
                      setPhase("search");
                      setOutcomes(new Map());
                    }}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    {t("discovery.newSearch")}
                  </Button>
                ) : null}
                {phase !== "done" ? (
                  <Button
                    disabled={phase !== "results" || selected.size === 0}
                    onClick={() => void runImport()}
                    size="sm"
                    type="button"
                  >
                    {phase === "importing" ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : null}
                    {t("discovery.import", { count: selected.size })}
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
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
