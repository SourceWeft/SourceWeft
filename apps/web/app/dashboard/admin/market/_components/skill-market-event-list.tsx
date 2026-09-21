"use client";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import type { SkillMarketEvent } from "@sourceweft/contracts";
import { Badge } from "@sourceweft/ui-web/components/ui/badge";

type Translator = ReturnType<typeof useTranslations>;

function shortId(id: string | null) {
  return id ? id.slice(0, 8) : "?";
}

const text = (value: unknown) =>
  typeof value === "string" ? value : value == null ? null : String(value);

/** A from/to pair recorded as `{ from, to }`, when it is one. */
function change(value: unknown): { from: unknown; to: unknown } | null {
  return value && typeof value === "object" && "to" in value
    ? (value as { from: unknown; to: unknown })
    : null;
}

function show(value: unknown, t: Translator): string {
  if (Array.isArray(value)) {
    return value.length ? value.join(", ") : t("events.summary.none");
  }
  if (value === null || value === undefined) return t("events.summary.none");
  return String(value);
}

/**
 * The human label for an action; an unknown action shows as its name. `t` is
 * the `dashboardSkillsMarketAdmin` translator, as for the helpers below.
 */
export function skillMarketEventLabel(action: string, t: Translator): string {
  // Actions are `<area>.<verb>`, stored nested in the messages; anything
  // else would name a group, not a label.
  return /^[a-z_]+\.[a-z_]+$/.test(action) && t.has(`events.actions.${action}`)
    ? t(`events.actions.${action}`)
    : action;
}

const SUMMARY_FIELDS = [
  "visibility",
  "listingHoldBy",
  "verified",
  "featured",
  "categorySlugs",
  "status",
] as const;

/**
 * One line of what an event changed, from its small structured detail: the
 * versions behind a cleared badge, from → to pairs, a reason. Recorded values
 * and the admin's reason are shown as they were stored.
 */
export function skillMarketEventSummary(
  event: SkillMarketEvent,
  t: Translator,
): string {
  const detail = event.detail;
  if (event.action === "verified.cleared") {
    return t("events.verifiedCleared", {
      from: shortId(text(detail.fromVersionId)),
      to: shortId(text(detail.toVersionId)),
    });
  }
  const parts: string[] = [];
  for (const key of SUMMARY_FIELDS) {
    const pair = change(detail[key]);
    if (pair) {
      parts.push(
        t("events.summary.change", {
          field: t(`events.summary.fields.${key}`),
          from: show(pair.from, t),
          to: show(pair.to, t),
        }),
      );
    }
  }
  if (typeof detail.reason === "string" && detail.reason) {
    parts.push(`“${detail.reason}”`);
  }
  if (typeof detail.skillCount === "number") {
    parts.push(t("events.summary.skillCount", { count: detail.skillCount }));
  }
  if (detail.bulk === true && typeof detail.changed === "number") {
    parts.push(
      t("events.summary.bulk", {
        considered: String(detail.considered),
        changed: detail.changed,
      }),
    );
  }
  return parts.join(" · ");
}

/** Who did it: the actor's name (or id), with what kind of actor they were. */
export function skillMarketEventActor(
  event: SkillMarketEvent,
  t: Translator,
): string {
  if (event.actorKind === "system" || !event.actorUserId) {
    return t("events.platform");
  }
  const kind = t.has(`events.actorKind.${event.actorKind}`)
    ? t(`events.actorKind.${event.actorKind}`)
    : event.actorKind;
  return t("events.actor", {
    name: event.actorName ?? event.actorUserId,
    kind,
  });
}

/** Date and time in the viewer's own time zone, worded for `locale`. */
export function formatEventTime(value: string, locale: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString(locale, {
        dateStyle: "medium",
        timeStyle: "short",
      });
}

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
  const t = useTranslations("dashboardSkillsMarketAdmin");
  const locale = useLocale();
  return (
    <ul className="divide-y divide-border text-xs" data-testid="market-events">
      {events.map((event) => {
        const summary = skillMarketEventSummary(event, t);
        return (
          <li
            className="space-y-1 py-2"
            data-action={event.action}
            key={event.id}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-foreground">
                {skillMarketEventLabel(event.action, t)}
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
                {skillMarketEventActor(event, t)} ·{" "}
                {formatEventTime(event.createdAt, locale)}
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
