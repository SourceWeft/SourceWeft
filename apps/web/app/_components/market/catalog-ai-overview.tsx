"use client";

import type { ReactNode } from "react";
import { AlertTriangle, Info, Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@sourceweft/ui-web/components/ui/alert";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@sourceweft/ui-web/components/ui/tooltip";
import { cn } from "@sourceweft/ui-web/lib/utils";

/**
 * A catalog entry's AI overview (a skill, an MCP server), already in the
 * language to show. The same shape for every kind.
 */
export type CatalogAiOverviewContent = {
  summary: string;
  whatItDoes: string;
  whenToUse: string;
  // "" when it needs nothing.
  requirements: string;
  // What to know before installing; null or blank when there is nothing.
  cautions?: string | null;
  // Taxonomy slugs the model proposed. Not shown here: the entry's own
  // categories carry them once applied.
  suggestedCategories?: readonly string[];
};

/** The words around an overview, which each kind words for itself. */
export type CatalogAiOverviewLabels = {
  // The "AI-generated" label: the block's heading and accessible name.
  title: string;
  whatItDoes: string;
  whenToUse: string;
  requirements: string;
};

export type CatalogAiOverviewProps = {
  overview: CatalogAiOverviewContent;
  labels: CatalogAiOverviewLabels;
  // Where the overview came from, behind an info button next to the title.
  explainer?: { label: string; text: string };
  // A note under the overview, e.g. that it is shown in another language.
  notice?: ReactNode;
  // Its provenance, e.g. the model and when it was generated.
  meta?: ReactNode;
  className?: string;
  "data-testid"?: string;
};

/**
 * An AI overview as a compact, labelled block: the summary, then what it
 * does, when to use it and its requirements (each left out when empty), then
 * any cautions as a calm notice.
 *
 * The text is model output from third-party content. It goes out as React
 * text children only — never markdown, never HTML — so nothing in it can
 * become a link, an image or markup.
 */
export function CatalogAiOverview({
  overview,
  labels,
  explainer,
  notice,
  meta,
  className,
  "data-testid": testId = "catalog-ai-overview",
}: CatalogAiOverviewProps) {
  const sections = [
    { label: labels.whatItDoes, text: overview.whatItDoes },
    { label: labels.whenToUse, text: overview.whenToUse },
    { label: labels.requirements, text: overview.requirements },
  ].filter((section) => section.text.trim());
  const cautions = overview.cautions?.trim() ? overview.cautions : null;

  return (
    <section
      aria-label={labels.title}
      data-testid={testId}
      className={cn(
        "mb-4 rounded-lg border border-dashed bg-muted/30 p-4 text-sm",
        className,
      )}
    >
      <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Sparkles className="size-3.5" aria-hidden />
        <span>{labels.title}</span>
        {explainer ? (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={explainer.label}
                  className="inline-flex text-muted-foreground hover:text-foreground"
                >
                  <Info className="size-3.5" aria-hidden />
                </button>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                {explainer.text}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : null}
      </div>
      <p className="font-medium text-foreground">{overview.summary}</p>
      {sections.length > 0 ? (
        <dl className="mt-3 grid gap-2">
          {sections.map((section) => (
            <div key={section.label}>
              <dt className="text-xs font-medium text-muted-foreground">
                {section.label}
              </dt>
              <dd className="whitespace-pre-line text-foreground/90">
                {section.text}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {cautions ? <CatalogAiOverviewCautions text={cautions} /> : null}
      {notice ? (
        <p className="mt-3 text-xs text-muted-foreground">{notice}</p>
      ) : null}
      {meta ? (
        <p className="mt-3 text-xs text-muted-foreground">{meta}</p>
      ) : null}
    </section>
  );
}

/**
 * What to know before installing, set apart from the rest of the overview.
 * A note, not an alert: it is part of the page, not news to announce.
 */
function CatalogAiOverviewCautions({ text }: { text: string }) {
  const t = useTranslations("market.overview");
  return (
    <Alert
      role="note"
      data-testid="catalog-ai-overview-cautions"
      className="mt-3 border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200"
    >
      <AlertTriangle aria-hidden />
      <AlertTitle>{t("cautions")}</AlertTitle>
      <AlertDescription className="whitespace-pre-line text-inherit">
        {text}
      </AlertDescription>
    </Alert>
  );
}
