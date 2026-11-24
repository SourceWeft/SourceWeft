"use client";

import { useMemo, useState } from "react";
import { CheckCircle2, CircleAlert, Clock, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import type { ResearchRun } from "@sourceweft/contracts/source-research";
import { Badge } from "@sourceweft/ui-web/components/ui/badge";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { Checkbox } from "@sourceweft/ui-web/components/ui/checkbox";
import { UntrustedMarkdown } from "../../../../../_components/market/untrusted-markdown";
import { contentClient } from "../../../../../../lib/sdk";
import {
  importCandidates,
  type ImportOutcome,
} from "../discovery/import-candidates";

const CITE_HREF = /^#cite-(\d+)$/;

/** One page for matching: no fragment, no trailing slash. */
function pageKey(url: string) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return url;
  }
}

/** Turns each verified `[n]` marker into a link the reader can hover. */
function linkCitations(report: string, count: number) {
  return report.replace(/\[(\d+)\](?!\()/g, (all, digits: string) => {
    const n = Number(digits);
    return n >= 1 && n <= count ? `[\\[${n}\\]](#cite-${n})` : all;
  });
}

export function ResearchReport({
  existingUrls,
  onImported,
  onSaved,
  run,
  saved,
  workspaceId,
}: {
  existingUrls: readonly string[];
  onImported: () => void;
  onSaved: () => void;
  run: ResearchRun;
  saved: boolean;
  workspaceId: string;
}) {
  const t = useTranslations("dashboardSourcesHub");
  const pages = useMemo(() => {
    const seen = new Set<string>();
    return run.sources.filter((source) => {
      const key = pageKey(source.url);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [run.sources]);
  const existing = useMemo(
    () => new Set(existingUrls.map(pageKey)),
    [existingUrls],
  );
  const [unchecked, setUnchecked] = useState<Set<string>>(() => new Set());
  const [importing, setImporting] = useState(false);
  const [outcomes, setOutcomes] = useState<Map<string, ImportOutcome>>(
    () => new Map(),
  );
  const [saving, setSaving] = useState(false);
  const [active, setActive] = useState<number | null>(null);

  const isAdded = (url: string) => {
    const outcome = outcomes.get(url);
    return (
      existing.has(pageKey(url)) ||
      outcome?.kind === "indexed" ||
      outcome?.kind === "pending" ||
      outcome?.kind === "existing"
    );
  };
  const chosen = pages.filter(
    (page) => !unchecked.has(page.url) && !isAdded(page.url),
  );

  const toggle = (url: string) =>
    setUnchecked((current) => {
      const next = new Set(current);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });

  const runImport = async () => {
    const urls = chosen.map((page) => page.url);
    if (urls.length === 0 || importing) return;
    setImporting(true);
    try {
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
      onImported();
      const added = results.filter(
        (item) => item.kind === "indexed" || item.kind === "pending",
      ).length;
      if (added > 0) toast.success(t("discovery.imported", { count: added }));
    } finally {
      setImporting(false);
    }
  };

  const save = async () => {
    if (saving || saved) return;
    setSaving(true);
    try {
      await contentClient.saveResearchNote(workspaceId, run.id);
      toast.success(t("research.saved"));
      onSaved();
    } catch {
      toast.error(t("research.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const citation = active === null ? null : run.citations[active - 1];
  const citedSource = citation
    ? run.sources.find((source) => source.entryId === citation.entryId)
    : undefined;
  const citeAt = (target: EventTarget | null) => {
    const link =
      target instanceof Element ? target.closest('a[href^="#cite-"]') : null;
    const match = link ? CITE_HREF.exec(link.getAttribute("href") ?? "") : null;
    return match ? Number(match[1]) : null;
  };

  return (
    <div className="space-y-3">
      <div
        className="max-h-80 overflow-y-auto rounded-md border p-3 [overflow-wrap:anywhere]"
        onClick={(event) => {
          const n = citeAt(event.target);
          if (n !== null) {
            event.preventDefault();
            setActive(n);
          }
        }}
        onFocus={(event) => {
          const n = citeAt(event.target);
          if (n !== null) setActive(n);
        }}
        onMouseLeave={() => setActive(null)}
        onMouseOver={(event) => {
          const n = citeAt(event.target);
          if (n !== null) setActive(n);
        }}
      >
        <UntrustedMarkdown imagePlaceholder={t("research.image")} mode="skill">
          {linkCitations(run.report ?? "", run.citations.length)}
        </UntrustedMarkdown>
      </div>

      {citation ? (
        <div
          className="bg-muted/50 rounded-md border p-2 text-xs"
          data-testid="research-citation"
        >
          <p>&ldquo;{citation.quote}&rdquo;</p>
          {citedSource ? (
            <p className="text-muted-foreground mt-1 break-all">
              {citedSource.title ? `${citedSource.title} · ` : ""}
              {citedSource.url}
            </p>
          ) : null}
        </div>
      ) : null}

      {pages.length > 0 ? (
        <div className="space-y-1">
          <p className="text-sm font-medium">{t("research.sources")}</p>
          <ul className="max-h-48 space-y-1 overflow-y-auto">
            {pages.map((page) => {
              const outcome = outcomes.get(page.url);
              const added = isAdded(page.url);
              const label = page.title || page.url;
              return (
                <li
                  className="flex items-start gap-3 rounded-lg border px-3 py-2"
                  key={page.url}
                >
                  <Checkbox
                    aria-label={label}
                    checked={added ? false : !unchecked.has(page.url)}
                    className="mt-1"
                    disabled={added || importing}
                    onCheckedChange={() => toggle(page.url)}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">
                        {label}
                      </span>
                      {added ? (
                        <Badge variant="outline">
                          {t("discovery.alreadyAdded")}
                        </Badge>
                      ) : null}
                    </div>
                    <div className="text-muted-foreground truncate text-xs">
                      {page.url}
                    </div>
                    {outcome?.kind === "failed" ? (
                      <p className="text-destructive mt-1 text-xs">
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
                    ) : outcome?.kind === "failed" ||
                      outcome?.kind === "quota" ? (
                      <CircleAlert className="text-destructive size-4" />
                    ) : outcome?.kind === "pending" ? (
                      <Clock className="text-muted-foreground size-4" />
                    ) : importing && !unchecked.has(page.url) && !added ? (
                      <Loader2 className="text-muted-foreground size-4 animate-spin" />
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button
          disabled={chosen.length === 0 || importing}
          onClick={() => void runImport()}
          size="sm"
          type="button"
        >
          {importing ? <Loader2 className="size-4 animate-spin" /> : null}
          {t("research.importSources", { count: chosen.length })}
        </Button>
        {saved ? (
          <Button disabled size="sm" type="button" variant="outline">
            <CheckCircle2 className="size-4" />
            {t("research.savedLabel")}
          </Button>
        ) : (
          <Button
            disabled={saving}
            onClick={() => void save()}
            size="sm"
            type="button"
            variant="outline"
          >
            {t("research.saveNote")}
          </Button>
        )}
      </div>
    </div>
  );
}
