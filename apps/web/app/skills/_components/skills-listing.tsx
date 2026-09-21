import Link from "next/link";
import { ArrowLeft, ArrowRight, Search } from "lucide-react";
import type {
  ListMarketSkillsResponse,
  MarketSkillCategory,
} from "@sourceweft/market-sdk";

import { cn } from "@sourceweft/ui-web/lib/utils";

import { SkillIcon } from "../../_components/site-icons";
import {
  hasOnlyCategoryFacet,
  skillCapabilityOptions,
  skillsBrowseHref,
  skillSortOptions,
  skillTrustOptions,
  type SkillsBrowseState,
} from "./skills-browse";
import { SkillCardGrid, skillCategoryNames } from "./skills-display";
import { skillsContainerClassName } from "./skills-format";
import { skillsCopy } from "./skills-public-copy";

export function SkillsSearchForm({
  action,
  className,
  state,
}: {
  /** Form target; the category page keeps the search inside its own route. */
  action: string;
  className?: string;
  state: SkillsBrowseState;
}) {
  return (
    <form action={action} className={className}>
      {state.sort !== "recommended" ? (
        <input name="sort" type="hidden" value={state.sort} />
      ) : null}
      {state.trust !== "all" ? (
        <input name="trust" type="hidden" value={state.trust} />
      ) : null}
      {state.capability !== "all" ? (
        <input name="type" type="hidden" value={state.capability} />
      ) : null}
      <div className="relative max-w-3xl">
        <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-zinc-400" />
        <input
          aria-label={skillsCopy.landing.searchLabel}
          className="h-14 w-full rounded-xl border border-zinc-300 bg-white/78 pl-11 pr-28 text-sm text-zinc-950 shadow-[0_18px_70px_rgba(39,39,42,0.08)] outline-none transition-colors placeholder:text-zinc-400 focus:border-zinc-950 dark:border-white/10 dark:bg-white/[0.05] dark:text-white dark:shadow-[0_18px_70px_rgba(0,0,0,0.28)] dark:focus:border-white/45"
          defaultValue={state.query}
          maxLength={200}
          name="q"
          placeholder={skillsCopy.landing.searchPlaceholder}
          type="search"
        />
        <button
          className="absolute right-2 top-1/2 h-10 -translate-y-1/2 rounded-lg bg-zinc-950 px-4 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-100"
          type="submit"
        >
          {skillsCopy.landing.searchSubmit}
        </button>
      </div>
    </form>
  );
}

function Pill({
  active,
  children,
  href,
}: {
  active: boolean;
  children: React.ReactNode;
  href: string;
}) {
  return (
    <Link
      aria-current={active ? "page" : undefined}
      className={cn(
        "shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
        active
          ? "border-zinc-950 bg-zinc-950 text-white dark:border-white dark:bg-white dark:text-zinc-950"
          : "border-zinc-300 bg-white/50 text-zinc-600 hover:border-zinc-950 hover:text-zinc-950 dark:border-white/12 dark:bg-white/[0.03] dark:text-zinc-400 dark:hover:border-white/35 dark:hover:text-white",
      )}
      href={href}
      scroll={false}
    >
      {children}
    </Link>
  );
}

function CategorySidebar({
  categories,
  state,
  total,
}: {
  categories: MarketSkillCategory[];
  state: SkillsBrowseState;
  total: number;
}) {
  const entries = [
    { count: total, label: skillsCopy.listing.allSkills, slug: "all" },
    // An empty category is a dead end; the one being browsed always stays.
    ...categories
      .filter(
        (category) => category.count > 0 || category.slug === state.category,
      )
      .map((category) => ({
        count: category.count,
        label: category.name,
        slug: category.slug,
      })),
  ];
  return (
    <aside className="lg:sticky lg:top-20 lg:self-start">
      <p className="mb-3 hidden text-xs font-semibold uppercase text-zinc-400 lg:block">
        {skillsCopy.listing.categories}
      </p>
      <nav className="-mx-5 flex gap-2 overflow-x-auto px-5 pb-2 [scrollbar-width:none] sm:-mx-6 sm:px-6 lg:mx-0 lg:flex-col lg:gap-0.5 lg:overflow-visible lg:px-0 lg:pb-0 [&::-webkit-scrollbar]:hidden">
        {entries.map((entry) => {
          const active = state.category === entry.slug;
          return (
            <Link
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex shrink-0 items-center justify-between gap-3 rounded-full border px-3 py-1.5 text-sm transition-colors lg:rounded-lg lg:border-transparent lg:py-2",
                active
                  ? "border-zinc-950 bg-zinc-950 text-white dark:border-white dark:bg-white dark:text-zinc-950"
                  : "border-zinc-300 text-zinc-600 hover:bg-white/70 hover:text-zinc-950 dark:border-white/12 dark:text-zinc-400 dark:hover:bg-white/[0.05] dark:hover:text-white",
              )}
              href={skillsBrowseHref(state, {
                category: entry.slug,
                view: true,
              })}
              key={entry.slug}
            >
              <span className="truncate">{entry.label}</span>
              <span
                className={cn(
                  "text-xs tabular-nums",
                  active ? "opacity-70" : "text-zinc-400",
                )}
              >
                {entry.count.toLocaleString("en")}
              </span>
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}

/**
 * The faceted listing shared by /skills (search and "view all") and every
 * /skills/category/[slug] page, so both browse the catalog the same way.
 */
export function SkillsListingView({
  categories,
  market,
  state,
  title,
  total,
}: {
  categories: MarketSkillCategory[];
  market: ListMarketSkillsResponse;
  state: SkillsBrowseState;
  /** Omitted when the page header already names the listing. */
  title?: string;
  total: number;
}) {
  const categoryNames = skillCategoryNames(categories);
  // The API counts whatever the filters and search match; an older API that
  // does not only has the category counts to go on.
  const exactCount =
    market.totalCount ??
    (hasOnlyCategoryFacet(state)
      ? state.category === "all"
        ? total
        : (categories.find((category) => category.slug === state.category)
            ?.count ?? 0)
      : null);
  const hasFilters =
    Boolean(state.query) ||
    state.category !== "all" ||
    state.trust !== "all" ||
    state.capability !== "all";

  return (
    <section
      className={cn(
        "mx-auto grid grid-cols-[minmax(0,1fr)] gap-6 py-8 lg:grid-cols-[232px_minmax(0,1fr)] lg:gap-10",
        skillsContainerClassName,
      )}
    >
      <CategorySidebar categories={categories} state={state} total={total} />

      <div className="min-w-0">
        <div className="flex flex-col gap-4 border-b border-zinc-300 pb-5 dark:border-white/10">
          <div className="flex flex-wrap items-end justify-between gap-3">
            {title ? (
              <div className="min-w-0">
                <Link
                  className="mb-2 inline-flex items-center gap-1.5 text-xs text-zinc-500 transition-colors hover:text-zinc-950 dark:hover:text-white"
                  href="/skills"
                >
                  <ArrowLeft className="size-3.5" />
                  {skillsCopy.listing.marketHome}
                </Link>
                <h1 className="truncate text-2xl font-semibold tracking-tight">
                  {title}
                </h1>
              </div>
            ) : null}
            <p className="ml-auto text-sm text-zinc-500 dark:text-zinc-400">
              {exactCount !== null
                ? skillsCopy.listing.exactCount(exactCount)
                : skillsCopy.listing.pageCount(market.items.length)}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <div
              aria-label={skillsCopy.listing.sortLabel}
              className="flex flex-wrap gap-1.5"
              role="group"
            >
              {skillSortOptions.map((option) => (
                <Pill
                  active={state.sort === option.value}
                  href={skillsBrowseHref(state, {
                    sort: option.value,
                    view: true,
                  })}
                  key={option.value}
                >
                  {option.label}
                </Pill>
              ))}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {skillTrustOptions.map((option) => (
                <Pill
                  active={state.trust === option.value}
                  href={skillsBrowseHref(state, {
                    trust: option.value,
                    view: true,
                  })}
                  key={option.value}
                >
                  {option.label}
                </Pill>
              ))}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {skillCapabilityOptions.map((option) => (
                <Pill
                  active={state.capability === option.value}
                  href={skillsBrowseHref(state, {
                    capability: option.value,
                    view: true,
                  })}
                  key={option.value}
                >
                  {option.label}
                </Pill>
              ))}
            </div>
            {hasFilters ? (
              <Link
                className="text-xs font-medium text-zinc-500 underline decoration-zinc-300 underline-offset-4 hover:text-zinc-950 dark:decoration-white/20 dark:hover:text-white"
                href="/skills?view=all"
              >
                {skillsCopy.listing.clearFilters}
              </Link>
            ) : null}
          </div>
        </div>

        {market.items.length > 0 ? (
          <SkillCardGrid
            categoryNames={categoryNames}
            className="mt-6 md:grid-cols-2 xl:grid-cols-2 2xl:grid-cols-3"
            highlightCategory={state.category}
            skills={market.items}
          />
        ) : (
          <div className="mt-6 rounded-xl border border-zinc-300 bg-white/54 p-10 text-center dark:border-white/10 dark:bg-white/[0.03]">
            <SkillIcon className="mx-auto mb-4 size-8 text-zinc-400" />
            <h2 className="text-xl font-semibold tracking-tight">
              {hasFilters
                ? skillsCopy.listing.noMatchTitle
                : skillsCopy.landing.emptyTitle}
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-zinc-500 dark:text-zinc-400">
              {hasFilters
                ? skillsCopy.listing.noMatchBody
                : skillsCopy.landing.emptyBody}
            </p>
          </div>
        )}

        {state.cursor || market.nextCursor ? (
          <nav
            aria-label={skillsCopy.listing.pagination}
            className="mt-8 flex items-center justify-between gap-4 border-t border-zinc-300 pt-6 dark:border-white/10"
          >
            {state.cursor ? (
              <Link
                className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-zinc-300 px-4 text-sm font-medium transition-colors hover:border-zinc-950 dark:border-white/12 dark:hover:border-white/40"
                href={skillsBrowseHref(state, { view: true })}
              >
                <ArrowLeft className="size-4" />
                {skillsCopy.listing.firstPage}
              </Link>
            ) : (
              <span />
            )}
            {market.nextCursor ? (
              <Link
                className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-zinc-950 px-4 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-100"
                href={skillsBrowseHref(state, {
                  cursor: market.nextCursor,
                  view: true,
                })}
                rel="next"
              >
                {skillsCopy.listing.nextPage}
                <ArrowRight className="size-4" />
              </Link>
            ) : null}
          </nav>
        ) : null}
      </div>
    </section>
  );
}
