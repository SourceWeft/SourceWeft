"use client";

import { Info, Sparkles } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@sourceweft/ui-web/components/ui/tooltip";
import type { MarketSkillAiOverview } from "../../../../../lib/skill-overviews";
import { skillOverviewCopy } from "./skill-overview-copy";

export type SkillAiOverviewLabels = {
  title: string;
  explainer: string;
  explainerLabel: string;
  whatItDoes: string;
  whenToUse: string;
  requirements: string;
  englishFallback: string;
};

/**
 * An AI overview as a compact, labelled block. Pure: it only renders what it
 * is given, so the public skill page can use it too.
 *
 * The text is model output from third-party content. It goes out as React
 * text children only — never markdown, never HTML — so nothing in it can
 * become a link, an image or markup.
 */
export function SkillAiOverviewView({
  overview,
  requestedLocale,
  labels = skillOverviewCopy.block,
}: {
  overview: MarketSkillAiOverview;
  // The language asked for; a note shows when the overview fell back.
  requestedLocale?: string;
  labels?: SkillAiOverviewLabels;
}) {
  const sections = [
    { label: labels.whatItDoes, text: overview.whatItDoes },
    { label: labels.whenToUse, text: overview.whenToUse },
    { label: labels.requirements, text: overview.requirements },
  ].filter((section) => section.text.trim());
  const fellBack =
    requestedLocale !== undefined && requestedLocale !== overview.locale;

  return (
    <section
      aria-label={labels.title}
      data-testid="skill-ai-overview"
      className="mb-4 rounded-lg border border-dashed bg-muted/30 p-4 text-sm"
    >
      <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Sparkles className="size-3.5" aria-hidden />
        <span>{labels.title}</span>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={labels.explainerLabel}
                className="inline-flex text-muted-foreground hover:text-foreground"
              >
                <Info className="size-3.5" aria-hidden />
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              {labels.explainer}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
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
      {fellBack ? (
        <p className="mt-3 text-xs text-muted-foreground">
          {labels.englishFallback}
        </p>
      ) : null}
    </section>
  );
}
