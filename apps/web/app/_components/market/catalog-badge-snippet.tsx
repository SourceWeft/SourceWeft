"use client";

import { useId, useState } from "react";
import { ChevronRight } from "lucide-react";
import { useTranslations } from "next-intl";

import { cn } from "@sourceweft/ui-web/lib/utils";

import { trackBadgeSnippetCopied } from "../../../lib/analytics-events";
import {
  badgeHtml,
  badgeMarkdown,
  catalogBadgeUrls,
  LISTED_BADGE_WIDTH,
  type CatalogBadgeTarget,
} from "../../../lib/catalog-badge";
import { CopyButton } from "../../[locale]/mcp/_components/mcp-client";

type SnippetFormat = "markdown" | "html";

export type CatalogBadgeSurface =
  "mcp_detail" | "skill_detail" | "skill_owner" | "mcp_submit";

/**
 * The "Listed on SourceWeft" README badge of one listed entry: a preview of
 * the real badge and its Markdown and HTML snippets, each with a copy button.
 *
 * `disclosure` folds it behind a summary, for the public detail pages that
 * every visitor reads; `inline` shows it at once under the caller's `intro`,
 * for the moments an author is looking at their own listing. The snippets
 * always link to the canonical English page, whatever language this is in.
 */
export function CatalogBadgeSnippet({
  className,
  siteUrl,
  surface,
  target,
  ...display
}: {
  className?: string;
  siteUrl: string;
  surface: CatalogBadgeSurface;
  target: CatalogBadgeTarget;
} & ({ display: "disclosure" } | { display: "inline"; intro: string })) {
  const t = useTranslations("catalogBadge");
  const body = (
    <BadgeSnippetBody siteUrl={siteUrl} surface={surface} target={target} />
  );
  if (display.display === "inline") {
    return (
      <div className={className} data-testid="catalog-badge">
        <p className="text-xs leading-5 text-zinc-600 dark:text-zinc-400">
          {display.intro}
        </p>
        {body}
      </div>
    );
  }
  return (
    <details className={cn("group", className)} data-testid="catalog-badge">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-sm font-medium text-zinc-950 dark:text-white [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden="true"
          className="size-4 shrink-0 text-zinc-400 transition-transform group-open:rotate-90"
        />
        {t("summary")}
      </summary>
      <p className="mt-2 text-xs leading-5 text-zinc-600 dark:text-zinc-400">
        {t(`description.${target.kind}`)}
      </p>
      {body}
    </details>
  );
}

function BadgeSnippetBody({
  siteUrl,
  surface,
  target,
}: {
  siteUrl: string;
  surface: CatalogBadgeSurface;
  target: CatalogBadgeTarget;
}) {
  const t = useTranslations("catalogBadge");
  const id = useId();
  const [selected, setSelected] = useState<SnippetFormat>("markdown");
  const urls = catalogBadgeUrls(target, siteUrl);
  const snippet =
    selected === "markdown" ? badgeMarkdown(urls) : badgeHtml(urls);
  const formats: [SnippetFormat, string][] = [
    ["markdown", t("markdown")],
    ["html", t("html")],
  ];
  return (
    <>
      {/* The badge itself, from its own route: what a README will show. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        alt={t("previewAlt")}
        className="mt-3 block"
        height={20}
        loading="lazy"
        src={urls.badgeUrl}
        width={LISTED_BADGE_WIDTH}
      />
      <div className="mt-3 flex items-center justify-between gap-2">
        <div
          aria-label={t("formats")}
          className="inline-flex rounded-lg border border-zinc-300 p-0.5 text-xs dark:border-white/10"
          role="tablist"
        >
          {formats.map(([format, label]) => (
            <button
              aria-controls={`${id}-panel`}
              aria-selected={format === selected}
              className={cn(
                "rounded-md px-2.5 py-1",
                format === selected
                  ? "bg-zinc-950 font-medium text-white dark:bg-white dark:text-zinc-950"
                  : "text-zinc-500 transition-colors hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-white",
              )}
              id={`${id}-${format}`}
              key={format}
              onClick={() => setSelected(format)}
              role="tab"
              type="button"
            >
              {label}
            </button>
          ))}
        </div>
        <CopyButton
          className="h-7 shrink-0 px-2"
          copiedLabel={t("copied")}
          failedLabel={t("copyFailed")}
          label={t("copy")}
          onCopied={() =>
            trackBadgeSnippetCopied({
              kind: target.kind,
              method: selected,
              surface,
            })
          }
          value={snippet}
        />
      </div>
      <div
        aria-labelledby={`${id}-${selected}`}
        className="mt-2"
        id={`${id}-panel`}
        role="tabpanel"
      >
        <code className="block break-all rounded-lg bg-zinc-100 px-3 py-2 font-mono text-xs leading-5 text-zinc-800 dark:bg-white/10 dark:text-zinc-200">
          {snippet}
        </code>
      </div>
    </>
  );
}
