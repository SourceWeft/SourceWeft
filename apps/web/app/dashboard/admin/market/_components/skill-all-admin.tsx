"use client";

import * as React from "react";
import Link from "next/link";
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  RefreshCw,
  Search,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import type {
  SkillMarketAdminSkill,
  SkillMarketAdminStandingFilter,
  SkillMarketEvent,
} from "@sourceweft/contracts";
import { Badge } from "@sourceweft/ui-web/components/ui/badge";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { Input } from "@sourceweft/ui-web/components/ui/input";

import {
  errorMessage,
  listSkillMarketAdminSkills,
  listSkillMarketEvents,
  reinferAllSkillCategories,
  type SkillMarketAdminSkillsFilters,
} from "../../../../../lib/skill-market-audit";
import {
  formatEventTime,
  SkillMarketEventList,
} from "./skill-market-event-list";

const PAGE_SIZE = 50;
const EVENTS_PAGE_SIZE = 25;

const FLAG_KEYS = [
  "featured",
  "verified",
  "claimed",
  "flagged",
  "reported",
] as const;
type FlagKey = (typeof FLAG_KEYS)[number];
type Tri = "any" | "yes" | "no";

const STANDINGS: Array<SkillMarketAdminStandingFilter | "any"> = [
  "any",
  "public",
  "restricted",
  "held",
  "owner_held",
];

const selectClass =
  "h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground";

/** The filters as the form holds them, turned into what the API reads. */
export function toSkillFilters(form: {
  q: string;
  standing: SkillMarketAdminStandingFilter | "any";
  flags: Record<FlagKey, Tri>;
}): SkillMarketAdminSkillsFilters {
  const filters: SkillMarketAdminSkillsFilters = {};
  if (form.q.trim()) filters.q = form.q.trim();
  if (form.standing !== "any") filters.standing = form.standing;
  for (const key of FLAG_KEYS) {
    const value = form.flags[key];
    if (value !== "any") filters[key] = value === "yes";
  }
  return filters;
}

function StandingBadge({ skill }: { skill: SkillMarketAdminSkill }) {
  const t = useTranslations("dashboardSkillsMarketAdmin");
  if (skill.listingHoldBy === "admin") {
    return <Badge variant="destructive">{t("all.heldByAdmin")}</Badge>;
  }
  if (skill.listingHoldBy === "owner") {
    return <Badge variant="outline">{t("all.heldByOwner")}</Badge>;
  }
  return skill.visibility === "public" ? (
    <Badge variant="secondary">{t("all.public")}</Badge>
  ) : (
    <Badge variant="outline">{t("all.notListed")}</Badge>
  );
}

function SkillRow({ skill }: { skill: SkillMarketAdminSkill }) {
  const t = useTranslations("dashboardSkillsMarketAdmin");
  const locale = useLocale();
  const marks = [
    skill.featured ? t("all.flags.featured") : null,
    skill.verified ? t("all.flags.verified") : null,
    skill.claimed ? t("all.flags.claimed") : null,
  ].filter((mark): mark is string => mark !== null);
  return (
    <tr
      className="border-t border-border align-top"
      data-testid="admin-skill-row"
    >
      <td className="px-3 py-2">
        <Link
          className="font-medium text-foreground underline-offset-2 hover:underline"
          href={`/dashboard/skills/${encodeURIComponent(skill.slug)}`}
        >
          {skill.displayName}
        </Link>
        <div className="text-muted-foreground">
          <code>{skill.slug}</code>
          {skill.repo ? <span className="ml-2">{skill.repo}</span> : null}
        </div>
      </td>
      <td className="px-3 py-2">
        <StandingBadge skill={skill} />
      </td>
      <td className="px-3 py-2">
        <div className="flex flex-wrap gap-1">
          {marks.map((mark) => (
            <Badge
              className="h-5 px-1.5 text-[10px]"
              key={mark}
              variant="secondary"
            >
              {mark}
            </Badge>
          ))}
          {skill.flagCount > 0 ? (
            <Badge className="h-5 px-1.5 text-[10px]" variant="outline">
              {t("all.flagCount", { count: skill.flagCount })}
            </Badge>
          ) : null}
          {skill.openReportCount > 0 ? (
            <Badge className="h-5 px-1.5 text-[10px]" variant="destructive">
              {t("all.reportCount", { count: skill.openReportCount })}
            </Badge>
          ) : null}
        </div>
      </td>
      <td className="px-3 py-2 text-right tabular-nums">
        {skill.installCount}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">
        {skill.ratingAvg === null
          ? t("all.noRating")
          : t("all.rating", {
              avg: skill.ratingAvg.toFixed(1),
              count: skill.ratingCount,
            })}
      </td>
      <td className="px-3 py-2 text-muted-foreground">
        {formatEventTime(skill.updatedAt, locale)}
      </td>
    </tr>
  );
}

/** The collapsible feed of every market event, a page at a time. */
function RecentMarketEvents() {
  const t = useTranslations("dashboardSkillsMarketAdmin");
  const [open, setOpen] = React.useState(false);
  const [events, setEvents] = React.useState<SkillMarketEvent[]>([]);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [loaded, setLoaded] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(
    async (from: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const page = await listSkillMarketEvents({
          cursor: from,
          limit: EVENTS_PAGE_SIZE,
        });
        setEvents((current) =>
          from ? [...current, ...page.items] : page.items,
        );
        setCursor(page.nextCursor);
        setLoaded(true);
      } catch (caught) {
        setError(errorMessage(caught, t("events.failed")));
      } finally {
        setLoading(false);
      }
    },
    [t],
  );

  return (
    <section className="rounded-2xl border border-border bg-background p-4 shadow-xs">
      <button
        aria-expanded={open}
        className="flex w-full items-center gap-2 text-left text-sm font-semibold text-foreground"
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next && !loaded) void load(null);
        }}
        type="button"
      >
        {open ? (
          <ChevronDown className="size-4" />
        ) : (
          <ChevronRight className="size-4" />
        )}
        {t("events.feedTitle")}
      </button>
      {open ? (
        <div className="mt-3 space-y-2">
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
          {loaded && events.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("events.empty")}</p>
          ) : (
            <SkillMarketEventList events={events} showSkill />
          )}
          {cursor ? (
            <Button
              disabled={loading}
              onClick={() => void load(cursor)}
              size="sm"
              type="button"
              variant="outline"
            >
              {loading ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {t("events.loadMore")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** Every community skill, filterable, with recent market events (§17.1). */
export function SkillAllAdmin() {
  const t = useTranslations("dashboardSkillsMarketAdmin");
  const [q, setQ] = React.useState("");
  const [standing, setStanding] = React.useState<
    SkillMarketAdminStandingFilter | "any"
  >("any");
  const [flags, setFlags] = React.useState<Record<FlagKey, Tri>>({
    featured: "any",
    verified: "any",
    claimed: "any",
    flagged: "any",
    reported: "any",
  });
  // What the list shows: the filters as last applied (search on submit, the
  // selects at once).
  const [applied, setApplied] = React.useState<SkillMarketAdminSkillsFilters>(
    {},
  );
  const [items, setItems] = React.useState<SkillMarketAdminSkill[]>([]);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [reinferring, setReinferring] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);
  const request = React.useRef(0);

  const load = React.useCallback(
    async (filters: SkillMarketAdminSkillsFilters, from: string | null) => {
      const id = ++request.current;
      setLoading(true);
      setError(null);
      try {
        const page = await listSkillMarketAdminSkills(filters, {
          cursor: from,
          limit: PAGE_SIZE,
        });
        // A newer filter change answered first: drop this page.
        if (id !== request.current) return;
        setItems((current) =>
          from ? [...current, ...page.items] : page.items,
        );
        setCursor(page.nextCursor);
      } catch (caught) {
        if (id === request.current)
          setError(errorMessage(caught, t("all.failed")));
      } finally {
        if (id === request.current) setLoading(false);
      }
    },
    [t],
  );

  React.useEffect(() => {
    void load(applied, null);
  }, [applied, load]);

  function apply(next: {
    q?: string;
    standing?: SkillMarketAdminStandingFilter | "any";
    flags?: Record<FlagKey, Tri>;
  }) {
    setApplied(
      toSkillFilters({
        q: next.q ?? q,
        standing: next.standing ?? standing,
        flags: next.flags ?? flags,
      }),
    );
  }

  async function reinferAll() {
    if (!window.confirm(t("all.reinferConfirm"))) return;
    setReinferring(true);
    setNotice(null);
    try {
      const result = await reinferAllSkillCategories();
      setNotice(
        t("all.reinferDone", {
          considered: result.considered,
          changed: result.changed,
        }),
      );
    } catch (caught) {
      setNotice(errorMessage(caught, t("all.reinferFailed")));
    } finally {
      setReinferring(false);
    }
  }

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-border bg-background shadow-xs">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border p-4">
          <div>
            <h2 className="text-sm font-semibold text-foreground">
              {t("all.title")}
            </h2>
            <p className="text-xs text-muted-foreground">
              {t("all.description")}
            </p>
          </div>
          <Button
            disabled={reinferring}
            onClick={() => void reinferAll()}
            size="sm"
            type="button"
            variant="outline"
          >
            {reinferring ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            {t("all.reinfer")}
          </Button>
        </div>
        {notice ? (
          <p className="border-b border-border px-4 py-2 text-xs" role="status">
            {notice}
          </p>
        ) : null}

        <form
          className="flex flex-wrap items-center gap-2 border-b border-border p-4"
          onSubmit={(event) => {
            event.preventDefault();
            apply({});
          }}
        >
          <Input
            aria-label={t("all.searchLabel")}
            className="h-8 w-60 text-xs"
            onChange={(event) => setQ(event.target.value)}
            placeholder={t("all.searchPlaceholder")}
            value={q}
          />
          <Button size="sm" type="submit" variant="outline">
            <Search className="size-3.5" />
            {t("all.search")}
          </Button>
          <select
            aria-label={t("all.standingLabel")}
            className={selectClass}
            onChange={(event) => {
              const next = event.target.value as
                SkillMarketAdminStandingFilter | "any";
              setStanding(next);
              apply({ standing: next });
            }}
            value={standing}
          >
            {STANDINGS.map((value) => (
              <option key={value} value={value}>
                {t(`all.standing.${value}`)}
              </option>
            ))}
          </select>
          {FLAG_KEYS.map((key) => (
            <label
              className="flex items-center gap-1 text-xs text-muted-foreground"
              key={key}
            >
              {t(`all.flags.${key}`)}
              <select
                aria-label={t(`all.flags.${key}`)}
                className={selectClass}
                onChange={(event) => {
                  const next = { ...flags, [key]: event.target.value as Tri };
                  setFlags(next);
                  apply({ flags: next });
                }}
                value={flags[key]}
              >
                <option value="any">{t("all.tri.any")}</option>
                <option value="yes">{t("all.tri.yes")}</option>
                <option value="no">{t("all.tri.no")}</option>
              </select>
            </label>
          ))}
        </form>

        {error ? <p className="p-4 text-xs text-destructive">{error}</p> : null}
        {!loading && !error && items.length === 0 ? (
          <p className="p-4 text-xs text-muted-foreground">{t("all.empty")}</p>
        ) : null}
        {items.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">
                    {t("all.columns.skill")}
                  </th>
                  <th className="px-3 py-2 font-medium">
                    {t("all.columns.standing")}
                  </th>
                  <th className="px-3 py-2 font-medium">
                    {t("all.columns.marks")}
                  </th>
                  <th className="px-3 py-2 text-right font-medium">
                    {t("all.columns.installs")}
                  </th>
                  <th className="px-3 py-2 text-right font-medium">
                    {t("all.columns.rating")}
                  </th>
                  <th className="px-3 py-2 font-medium">
                    {t("all.columns.updated")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((skill) => (
                  <SkillRow key={skill.id} skill={skill} />
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        <div className="flex items-center gap-2 p-4">
          {loading ? (
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              {t("all.loading")}
            </span>
          ) : cursor ? (
            <Button
              onClick={() => void load(applied, cursor)}
              size="sm"
              type="button"
              variant="outline"
            >
              {t("all.loadMore")}
            </Button>
          ) : null}
        </div>
      </section>

      <RecentMarketEvents />
    </div>
  );
}
