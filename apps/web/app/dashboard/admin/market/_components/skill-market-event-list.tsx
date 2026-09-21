"use client";

import Link from "next/link";
import type { SkillMarketEvent } from "@sourceweft/contracts";
import { Badge } from "@sourceweft/ui-web/components/ui/badge";

import {
  formatEventTime,
  skillMarketEventActor,
  skillMarketEventLabel,
  skillMarketEventSummary,
} from "./skill-market-admin-copy";

/**
 * Market events as a list: what happened, to which skill (in the global
 * feed), who did it and when, and a one-line summary of what changed.
 */
export function SkillMarketEventList({
  events,
  showSkill,
}: {
  events: SkillMarketEvent[];
  /** The global feed names the skill or repository; a skill's own does not. */
  showSkill?: boolean;
}) {
  return (
    <ul className="divide-y divide-border text-xs" data-testid="market-events">
      {events.map((event) => {
        const summary = skillMarketEventSummary(event);
        return (
          <li
            className="space-y-1 py-2"
            data-action={event.action}
            key={event.id}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-foreground">
                {skillMarketEventLabel(event.action)}
              </span>
              {showSkill && event.skillSlug ? (
                <Link
                  className="text-primary underline-offset-2 hover:underline"
                  href={`/dashboard/skills/${encodeURIComponent(event.skillSlug)}`}
                >
                  {event.skillDisplayName ?? event.skillSlug}
                </Link>
              ) : null}
              {event.repo ? (
                <Badge className="h-5 px-1.5 text-[10px]" variant="outline">
                  {event.repo}
                </Badge>
              ) : null}
              <span className="ml-auto text-muted-foreground">
                {skillMarketEventActor(event)} ·{" "}
                {formatEventTime(event.createdAt)}
              </span>
            </div>
            {summary ? (
              <p className="break-words text-muted-foreground">{summary}</p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
