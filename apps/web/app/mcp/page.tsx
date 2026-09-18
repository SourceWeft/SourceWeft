import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  Search,
  Server,
  Upload,
  Wrench,
} from "lucide-react";
import type { MarketCategory, MarketItemSummary } from "@sourceweft/market-sdk";

import { cn } from "@sourceweft/ui-web/lib/utils";

import { resolveInitialLandingAuthState } from "../_landing/auth-state-server";
import { SourceWeftFooter } from "../_landing/components/sourceweft-footer";
import { SourceWeftHeader } from "../_landing/components/sourceweft-header";
import { SITE_NAME, SITE_URL } from "../seo";
import {
  countPublicMcpByCategory,
  listPublicMcp,
  listPublicMcpCategories,
} from "../../lib/market-mcp";
import {
  hasOnlyCategoryFacet,
  isMcpListView,
  mcpBrowseHref,
  mcpCountRequest,
  mcpListRequest,
  mcpRuntimeOptions,
  mcpTrustOptions,
  parseMcpBrowseState,
  type McpBrowseState,
  type McpSearchParams,
} from "./_components/mcp-browse";
import {
  McpCardGrid,
  mcpCategoryLabel,
  mcpCategoryNames,
  mcpContainerClassName,
  McpDirectorySection,
  mcpFaqItems,
  McpFaqSection,
  mcpPath,
} from "./_components/mcp-display";

export const revalidate = 300;

const HOME_SECTION_SIZE = 6;
const HOME_CATEGORY_SECTIONS = 4;

type PageProps = {
  searchParams: Promise<McpSearchParams>;
};

const baseDescription =
  "Browse public MCP servers for SourceWeft and other MCP clients. Discover HTTP, SSE, and desktop MCP servers with tools, runtime, and verification details.";

export async function generateMetadata({
  searchParams,
}: PageProps): Promise<Metadata> {
  const [params, categories] = await Promise.all([
    searchParams,
    listPublicMcpCategories(),
  ]);
  const state = parseMcpBrowseState(params, categories.items);
  const categoryOnly =
    state.category !== "all" &&
    !state.query &&
    !state.cursor &&
    hasOnlyCategoryFacet(state);

  if (categoryOnly) {
    const category = categories.items.find(
      (entry) => entry.slug === state.category,
    );
    const title = `${category?.name ?? state.category} MCP Servers`;
    const description =
      category?.description ??
      `Browse ${title.toLowerCase()} with tools, transport, runtime, and verification details.`;
    const url = `${SITE_URL}/mcp?category=${encodeURIComponent(state.category)}`;
    return {
      alternates: { canonical: url },
      description,
      openGraph: { description, siteName: SITE_NAME, title, type: "website", url },
      title,
    };
  }

  return {
    alternates: { canonical: `${SITE_URL}/mcp` },
    description: baseDescription,
    openGraph: {
      description:
        "A public directory of MCP servers with tools, transport, runtime, and verification details.",
      siteName: SITE_NAME,
      title: "MCP Server Marketplace",
      type: "website",
      url: `${SITE_URL}/mcp`,
    },
    // Search, facet, and paged views all collapse onto the canonical listing.
    ...(isMcpListView(state) ? { robots: { follow: true, index: false } } : {}),
    title: "MCP Server Marketplace",
  };
}

function uniqueItems(items: MarketItemSummary[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.identifier)) return false;
    seen.add(item.identifier);
    return true;
  });
}

async function loadHomeSections(input: {
  categories: MarketCategory[];
  counts: Record<string, number>;
}) {
  const topCategories = [...input.categories]
    .filter((category) => (input.counts[category.slug] ?? 0) > 0)
    .sort(
      (left, right) =>
        (input.counts[right.slug] ?? 0) - (input.counts[left.slug] ?? 0),
    )
    .slice(0, HOME_CATEGORY_SECTIONS);

  const [official, verified, latest, ...byCategory] = await Promise.all([
    listPublicMcp({ includeDesktopOnly: true, limit: HOME_SECTION_SIZE, official: true }),
    listPublicMcp({ includeDesktopOnly: true, limit: HOME_SECTION_SIZE, verified: true }),
    listPublicMcp({ includeDesktopOnly: true, limit: 100 }),
    ...topCategories.map((category) =>
      listPublicMcp({
        category: category.slug,
        includeDesktopOnly: true,
        limit: HOME_SECTION_SIZE,
      }),
    ),
  ]);

  return {
    categories: topCategories.map((category, index) => ({
      category,
      items: byCategory[index]?.items ?? [],
    })),
    featured: uniqueItems([...official.items, ...verified.items]).slice(
      0,
      HOME_SECTION_SIZE,
    ),
    recent: [...latest.items]
      .sort(
        (left, right) =>
          new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
      )
      .slice(0, HOME_SECTION_SIZE),
  };
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
  counts,
  state,
  total,
}: {
  categories: MarketCategory[];
  counts: Record<string, number>;
  state: McpBrowseState;
  total: number;
}) {
  const entries = [
    { count: total, label: "All servers", slug: "all" },
    ...categories.map((category) => ({
      count: counts[category.slug] ?? 0,
      label: category.name,
      slug: category.slug,
    })),
  ];
  return (
    <aside className="lg:sticky lg:top-20 lg:self-start">
      <p className="mb-3 hidden text-xs font-semibold uppercase text-zinc-400 lg:block">
        Categories
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
                !active && entry.count === 0 && "opacity-50",
              )}
              href={mcpBrowseHref(state, { category: entry.slug, view: true })}
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

function GetStartedPanels({ signedIn }: { signedIn: boolean }) {
  const dashboardHref = signedIn ? "/dashboard/mcp" : "/auth/sign-in";
  const panels = [
    {
      cta: signedIn ? "Open MCP in dashboard" : "Sign in to install",
      description: "Add any listed server to a SourceWeft workspace in three steps.",
      icon: Wrench,
      steps: [
        "Pick a server and review its tools, auth, and trust level.",
        "Add it from the MCP page in your workspace dashboard.",
        "Connect credentials privately, then enable it for chats.",
      ],
      title: "Install",
    },
    {
      cta: signedIn ? "Submit your server" : "Sign in to submit",
      description: "List your own MCP server for every SourceWeft workspace.",
      icon: Upload,
      steps: [
        "Publish your server source in a public GitHub repository.",
        "Submit the repository from the MCP page in the dashboard.",
        "It goes live after review; trusted publishers get a badge.",
      ],
      title: "Publish",
    },
  ];
  return (
    <div className="mt-10 grid gap-4 md:grid-cols-2">
      {panels.map((panel) => (
        <div
          className="flex flex-col rounded-xl border border-zinc-300 bg-white/62 p-5 dark:border-white/10 dark:bg-white/[0.035]"
          key={panel.title}
        >
          <div className="flex items-center gap-3">
            <span className="flex size-9 items-center justify-center rounded-lg bg-zinc-950 text-white dark:bg-white dark:text-zinc-950">
              <panel.icon className="size-4" />
            </span>
            <div>
              <h2 className="text-base font-semibold">{panel.title}</h2>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                {panel.description}
              </p>
            </div>
          </div>
          <ol className="mt-4 space-y-2 text-sm text-zinc-600 dark:text-zinc-400">
            {panel.steps.map((step, index) => (
              <li className="flex gap-3" key={step}>
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-zinc-300 text-[11px] font-medium tabular-nums dark:border-white/15">
                  {index + 1}
                </span>
                {step}
              </li>
            ))}
          </ol>
          <Link
            className="group mt-5 inline-flex items-center gap-1.5 self-start text-sm font-medium text-zinc-950 dark:text-white"
            href={dashboardHref}
          >
            {panel.cta}
            <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
          </Link>
        </div>
      ))}
    </div>
  );
}

export default async function PublicMcpMarketPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const [authState, categoriesResponse] = await Promise.all([
    resolveInitialLandingAuthState(),
    listPublicMcpCategories(),
  ]);
  const categories = categoriesResponse.items;
  const categoryNames = mcpCategoryNames(categories);
  const state = parseMcpBrowseState(params, categories);
  const listView = isMcpListView(state);

  const [facets, market] = await Promise.all([
    countPublicMcpByCategory(mcpCountRequest(state)),
    listView ? listPublicMcp(mcpListRequest(state)) : null,
  ]);
  // Home sections pick the busiest categories, so they wait on the facets.
  const home = listView
    ? null
    : await loadHomeSections({ categories, counts: facets.counts });

  const exactCount = hasOnlyCategoryFacet(state)
    ? state.category === "all"
      ? facets.total
      : (facets.counts[state.category] ?? 0)
    : null;
  const listTitle = state.query
    ? `Results for “${state.query}”`
    : state.category !== "all"
      ? `${mcpCategoryLabel(state.category, categoryNames)} MCP servers`
      : "All MCP servers";
  const hasFilters =
    Boolean(state.query) ||
    state.category !== "all" ||
    state.trust !== "all" ||
    state.runtime !== "all";

  const pageItems = market?.items ?? [
    ...(home?.featured ?? []),
    ...(home?.recent ?? []),
  ];
  const itemListJsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: uniqueItems(pageItems).map((item, index) => ({
      "@type": "ListItem",
      name: item.name,
      position: index + 1,
      url: `${SITE_URL}${mcpPath(item.identifier)}`,
    })),
  };
  const faqJsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: mcpFaqItems.map((item) => ({
      "@type": "Question",
      acceptedAnswer: {
        "@type": "Answer",
        text: item.answer,
      },
      name: item.question,
    })),
  };

  return (
    <main className="min-h-svh bg-[#f7f4ed] text-zinc-950 dark:bg-zinc-950 dark:text-white">
      <script
        dangerouslySetInnerHTML={{ __html: JSON.stringify(itemListJsonLd) }}
        type="application/ld+json"
      />
      {listView ? null : (
        <script
          dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
          type="application/ld+json"
        />
      )}
      <SourceWeftHeader
        authState={authState}
        containerClassName={mcpContainerClassName}
      />

      <section className="relative overflow-hidden border-b border-zinc-300 dark:border-white/10">
        <div
          aria-hidden
          className="absolute inset-0 bg-[linear-gradient(rgba(24,24,27,0.055)_1px,transparent_1px),linear-gradient(90deg,rgba(24,24,27,0.055)_1px,transparent_1px)] bg-[size:42px_42px] dark:bg-[linear-gradient(rgba(255,255,255,0.045)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.045)_1px,transparent_1px)]"
        />
        <div
          className={cn(
            "relative mx-auto",
            listView ? "pb-8 pt-24" : "pb-12 pt-28 lg:pb-16 lg:pt-32",
            mcpContainerClassName,
          )}
        >
          <div className="max-w-4xl">
            <span className="mb-5 inline-flex items-center gap-2 rounded-full border border-zinc-300 bg-white/48 px-3 py-1 text-xs font-medium text-zinc-600 dark:border-white/10 dark:bg-white/[0.04] dark:text-zinc-400">
              <Server className="size-3.5" />
              SourceWeft MCP Market
            </span>
            {listView ? (
              <p className="text-3xl font-semibold tracking-tight sm:text-4xl">
                MCP Server Marketplace
              </p>
            ) : (
              <>
                <h1 className="text-5xl font-semibold leading-[0.95] tracking-tight sm:text-6xl lg:text-7xl">
                  MCP Server Marketplace
                </h1>
                <p className="mt-6 max-w-2xl text-lg leading-8 text-zinc-600 dark:text-zinc-300">
                  {facets.total > 0
                    ? `Explore ${facets.total.toLocaleString("en")} MCP servers`
                    : "Explore MCP servers"}{" "}
                  with tools, transport, auth, and trust details up front, then
                  add them to a SourceWeft workspace.
                </p>
              </>
            )}
          </div>

          <form action="/mcp" className={listView ? "mt-6" : "mt-9"}>
            {state.category !== "all" ? (
              <input name="category" type="hidden" value={state.category} />
            ) : null}
            {state.trust !== "all" ? (
              <input name="trust" type="hidden" value={state.trust} />
            ) : null}
            {state.runtime !== "all" ? (
              <input name="runtime" type="hidden" value={state.runtime} />
            ) : null}
            <div className="relative max-w-3xl">
              <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-zinc-400" />
              <input
                aria-label="Search MCP servers"
                className="h-14 w-full rounded-xl border border-zinc-300 bg-white/78 pl-11 pr-28 text-sm text-zinc-950 shadow-[0_18px_70px_rgba(39,39,42,0.08)] outline-none transition-colors placeholder:text-zinc-400 focus:border-zinc-950 dark:border-white/10 dark:bg-white/[0.05] dark:text-white dark:shadow-[0_18px_70px_rgba(0,0,0,0.28)] dark:focus:border-white/45"
                defaultValue={state.query}
                name="q"
                placeholder="Search by name, provider, or capability"
                type="search"
              />
              <button
                className="absolute right-2 top-1/2 h-10 -translate-y-1/2 rounded-lg bg-zinc-950 px-4 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-100"
                type="submit"
              >
                Search
              </button>
            </div>
          </form>

          {listView ? null : <GetStartedPanels signedIn={authState.isSignedIn} />}
        </div>
      </section>

      {market ? (
        <section
          className={cn(
            "mx-auto grid grid-cols-[minmax(0,1fr)] gap-6 py-8 lg:grid-cols-[232px_minmax(0,1fr)] lg:gap-10",
            mcpContainerClassName,
          )}
        >
          <CategorySidebar
            categories={categories}
            counts={facets.counts}
            state={state}
            total={facets.total}
          />

          <div className="min-w-0">
            <div className="flex flex-col gap-4 border-b border-zinc-300 pb-5 dark:border-white/10">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div className="min-w-0">
                  <Link
                    className="mb-2 inline-flex items-center gap-1.5 text-xs text-zinc-500 transition-colors hover:text-zinc-950 dark:hover:text-white"
                    href="/mcp"
                  >
                    <ArrowLeft className="size-3.5" />
                    Market home
                  </Link>
                  <h1 className="truncate text-2xl font-semibold tracking-tight">
                    {listTitle}
                  </h1>
                </div>
                <p className="text-sm text-zinc-500 dark:text-zinc-400">
                  {exactCount !== null
                    ? `${exactCount.toLocaleString("en")} server${exactCount === 1 ? "" : "s"}`
                    : `${market.items.length} server${market.items.length === 1 ? "" : "s"} on this page`}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                <div className="flex flex-wrap gap-1.5">
                  {mcpTrustOptions.map((option) => (
                    <Pill
                      active={state.trust === option.value}
                      href={mcpBrowseHref(state, { trust: option.value, view: true })}
                      key={option.value}
                    >
                      {option.label}
                    </Pill>
                  ))}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {mcpRuntimeOptions.map((option) => (
                    <Pill
                      active={state.runtime === option.value}
                      href={mcpBrowseHref(state, { runtime: option.value, view: true })}
                      key={option.value}
                    >
                      {option.label}
                    </Pill>
                  ))}
                </div>
                {hasFilters ? (
                  <Link
                    className="text-xs font-medium text-zinc-500 underline decoration-zinc-300 underline-offset-4 hover:text-zinc-950 dark:decoration-white/20 dark:hover:text-white"
                    href="/mcp?view=all"
                  >
                    Clear filters
                  </Link>
                ) : null}
              </div>
            </div>

            {market.items.length > 0 ? (
              <McpCardGrid
                className="mt-6 md:grid-cols-2 xl:grid-cols-2 2xl:grid-cols-3"
                categoryNames={categoryNames}
                highlightCategory={state.category}
                items={market.items}
              />
            ) : (
              <div className="mt-6 rounded-xl border border-zinc-300 bg-white/54 p-10 text-center dark:border-white/10 dark:bg-white/[0.03]">
                <Server className="mx-auto mb-4 size-8 text-zinc-400" />
                <h2 className="text-xl font-semibold tracking-tight">
                  {hasFilters
                    ? "No MCP servers match these filters."
                    : "MCP servers are syncing."}
                </h2>
                <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-zinc-500 dark:text-zinc-400">
                  {hasFilters
                    ? "Try a broader search or another category."
                    : "The public market is available, but no published MCP servers are listed yet."}
                </p>
              </div>
            )}

            {state.cursor || market.nextCursor ? (
              <nav
                aria-label="Pagination"
                className="mt-8 flex items-center justify-between gap-4 border-t border-zinc-300 pt-6 dark:border-white/10"
              >
                {state.cursor ? (
                  <Link
                    className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-zinc-300 px-4 text-sm font-medium transition-colors hover:border-zinc-950 dark:border-white/12 dark:hover:border-white/40"
                    href={mcpBrowseHref(state, { view: true })}
                  >
                    <ArrowLeft className="size-4" />
                    First page
                  </Link>
                ) : (
                  <span />
                )}
                {market.nextCursor ? (
                  <Link
                    className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-zinc-950 px-4 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-100"
                    href={mcpBrowseHref(state, {
                      cursor: market.nextCursor,
                      view: true,
                    })}
                    rel="next"
                  >
                    Next page
                    <ArrowRight className="size-4" />
                  </Link>
                ) : null}
              </nav>
            ) : null}
          </div>
        </section>
      ) : null}

      {home ? (
        <div className={cn("mx-auto space-y-14 py-12", mcpContainerClassName)}>
          <McpDirectorySection
            categoryNames={categoryNames}
            description="Servers from official publishers or verified by review."
            items={home.featured}
            title="Featured"
            viewAllHref="/mcp?trust=verified"
          />
          <McpDirectorySection
            categoryNames={categoryNames}
            description="Freshly indexed servers and recently updated listings."
            items={home.recent}
            title="Recently updated"
            viewAllHref="/mcp?view=all"
          />
          {home.categories.map(({ category, items }) => (
            <McpDirectorySection
              categoryNames={categoryNames}
              description={
                category.description ??
                `Popular ${category.name.toLowerCase()} MCP servers.`
              }
              highlightCategory={category.slug}
              items={items}
              key={category.slug}
              title={category.name}
              viewAllHref={`/mcp?category=${encodeURIComponent(category.slug)}`}
            />
          ))}
          {home.featured.length === 0 && home.recent.length === 0 ? (
            <div className="rounded-xl border border-zinc-300 bg-white/54 p-10 text-center dark:border-white/10 dark:bg-white/[0.03]">
              <Server className="mx-auto mb-4 size-8 text-zinc-400" />
              <h2 className="text-2xl font-semibold tracking-tight">
                MCP servers are syncing.
              </h2>
              <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-zinc-500 dark:text-zinc-400">
                The public market is available, but no published MCP servers are
                listed yet.
              </p>
            </div>
          ) : null}

          {categories.length > 0 ? (
            <section>
              <h2 className="mb-5 text-2xl font-semibold tracking-tight">
                Browse by category
              </h2>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {categories.map((category) => (
                  <Link
                    className="group flex items-center justify-between gap-3 rounded-xl border border-zinc-300 bg-white/50 px-4 py-3 text-sm transition-colors hover:border-zinc-950 hover:bg-white dark:border-white/10 dark:bg-white/[0.03] dark:hover:border-white/35"
                    href={`/mcp?category=${encodeURIComponent(category.slug)}`}
                    key={category.slug}
                  >
                    <span className="truncate font-medium">{category.name}</span>
                    <span className="text-xs tabular-nums text-zinc-400">
                      {(facets.counts[category.slug] ?? 0).toLocaleString("en")}
                    </span>
                  </Link>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      ) : null}

      {listView ? null : <McpFaqSection />}

      <SourceWeftFooter
        authState={authState}
        containerClassName={mcpContainerClassName}
      />
    </main>
  );
}
