import type { Metadata } from "next";
import Link from "next/link";
import { Search, Server } from "lucide-react";
import type { MarketItemSummary } from "@sourceweft/market-sdk";

import { resolveInitialLandingAuthState } from "../_landing/auth-state-server";
import { SourceWeftFooter } from "../_landing/components/sourceweft-footer";
import { SourceWeftHeader } from "../_landing/components/sourceweft-header";
import { SITE_NAME, SITE_URL } from "../seo";
import { listPublicMcp, listPublicMcpCategories } from "../../lib/market-mcp";
import {
  mcpContainerClassName,
  mcpDirectorySections,
  McpDirectorySection,
  mcpFaqItems,
  McpFaqSection,
  mcpFilterTabs,
  McpMarketCard,
  queryForFilter,
  selectedMcpFilter,
} from "./_components/mcp-display";

export const revalidate = 300;

export const metadata: Metadata = {
  alternates: {
    canonical: `${SITE_URL}/mcp`,
  },
  description:
    "Browse public MCP servers for SourceWeft and other MCP clients. Discover HTTP, SSE, and desktop MCP servers with tools, runtime, and verification details.",
  openGraph: {
    description:
      "A public directory of MCP servers with tools, transport, runtime, and verification details.",
    siteName: SITE_NAME,
    title: "MCP Servers",
    type: "website",
    url: `${SITE_URL}/mcp`,
  },
  title: "MCP Servers",
};

function searchParamsValue(value?: string | string[]) {
  return Array.isArray(value) ? value[0] : value;
}

function includesCategory(item: MarketItemSummary, category: string) {
  return item.categories.some((entry) => entry.toLowerCase() === category);
}

function sectionItems(input: {
  filter?: string;
  items: MarketItemSummary[];
  title: string;
}) {
  if (input.title === "Featured MCP Servers") {
    return input.items
      .filter((item) => item.official || item.verified)
      .slice(0, 6);
  }
  if (input.title === "Recently Updated") {
    return [...input.items]
      .sort(
        (left, right) =>
          new Date(right.updatedAt).getTime() -
          new Date(left.updatedAt).getTime(),
      )
      .slice(0, 6);
  }
  return input.filter
    ? input.items.filter((item) => includesCategory(item, input.filter!)).slice(0, 6)
    : input.items.slice(0, 6);
}

export default async function PublicMcpMarketPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string | string[]; q?: string | string[] }>;
}) {
  const params = await searchParams;
  const [authState, categoriesResponse] = await Promise.all([
    resolveInitialLandingAuthState(),
    listPublicMcpCategories(),
  ]);
  const categories = categoriesResponse.items;
  const filterTabs = mcpFilterTabs(categories);
  const selectedFilter = selectedMcpFilter(params.filter, categories);
  const query = searchParamsValue(params.q)?.trim() ?? "";
  const market = await listPublicMcp({
    ...queryForFilter(selectedFilter),
    query: query || undefined,
  });
  const allMarket = query
    ? market
    : await listPublicMcp({ includeDesktopOnly: true, limit: 100 });
  const directoryItems = allMarket.items;
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
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
        type="application/ld+json"
      />
      <SourceWeftHeader
        authState={authState}
        containerClassName={mcpContainerClassName}
      />

      <section className="relative overflow-hidden border-b border-zinc-300 dark:border-white/10">
        <div
          aria-hidden
          className="absolute inset-0 bg-[linear-gradient(rgba(24,24,27,0.055)_1px,transparent_1px),linear-gradient(90deg,rgba(24,24,27,0.055)_1px,transparent_1px)] bg-[size:42px_42px] dark:bg-[linear-gradient(rgba(255,255,255,0.045)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.045)_1px,transparent_1px)]"
        />
        <div className={`relative mx-auto pb-12 pt-28 lg:pb-16 lg:pt-32 ${mcpContainerClassName}`}>
          <div className="max-w-4xl">
            <span className="mb-6 inline-flex items-center gap-2 rounded-full border border-zinc-300 bg-white/48 px-3 py-1 text-xs font-medium text-zinc-600 dark:border-white/10 dark:bg-white/[0.04] dark:text-zinc-400">
              <Server className="size-3.5" />
              SourceWeft MCP Market
            </span>
            <h1 className="text-5xl font-semibold leading-[0.95] tracking-tight text-zinc-950 sm:text-6xl lg:text-7xl dark:text-white">
              MCP Servers
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-zinc-600 dark:text-zinc-300">
              Browse public MCP servers for search, coding, data, productivity,
              and research workflows before adding them to a SourceWeft workspace.
            </p>
          </div>

          <form action="/mcp" className="mt-9">
            <input name="filter" type="hidden" value={selectedFilter} />
            <div className="relative max-w-3xl">
              <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-zinc-400" />
              <input
                className="h-14 w-full rounded-lg border border-zinc-300 bg-white/78 pl-11 pr-4 text-sm text-zinc-950 shadow-[0_18px_70px_rgba(39,39,42,0.08)] outline-none transition-colors placeholder:text-zinc-400 focus:border-zinc-950 dark:border-white/10 dark:bg-white/[0.05] dark:text-white dark:shadow-[0_18px_70px_rgba(0,0,0,0.28)] dark:focus:border-white/45"
                defaultValue={query}
                name="q"
                placeholder="Search MCP servers"
              />
            </div>
          </form>
        </div>
      </section>

      <section className={`mx-auto py-8 ${mcpContainerClassName}`}>
        <div className="flex gap-2 overflow-x-auto pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {filterTabs.map((tab) => (
            <Link
              className={`shrink-0 rounded-full border px-4 py-2 text-sm transition-colors ${
                selectedFilter === tab.value
                  ? "border-zinc-950 bg-zinc-950 text-white dark:border-white dark:bg-white dark:text-zinc-950"
                  : "border-zinc-300 bg-white/50 text-zinc-600 hover:border-zinc-950 hover:text-zinc-950 dark:border-white/12 dark:bg-white/[0.03] dark:text-zinc-400 dark:hover:border-white/35 dark:hover:text-white"
              }`}
              href={query ? `${tab.href}${tab.href.includes("?") ? "&" : "?"}q=${encodeURIComponent(query)}` : tab.href}
              key={tab.value}
            >
              {tab.label}
            </Link>
          ))}
        </div>
      </section>

      <section className={`mx-auto pb-16 ${mcpContainerClassName}`}>
        <div className="mb-6 flex flex-col justify-between gap-4 border-t border-zinc-300 pt-7 sm:flex-row sm:items-end dark:border-white/10">
          <div>
            <p className="text-xs font-semibold uppercase text-zinc-400">
              Public MCP directory
            </p>
            <h2 className="mt-2 text-3xl font-semibold tracking-tight">
              {query ? `Results for "${query}"` : "MCP servers"}
            </h2>
          </div>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            {market.items.length} server{market.items.length === 1 ? "" : "s"} in this view
          </p>
        </div>

        {market.items.length > 0 ? (
          <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
            {market.items.map((item) => (
              <McpMarketCard item={item} key={item.identifier} />
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-zinc-300 bg-white/54 p-10 text-center dark:border-white/10 dark:bg-white/[0.03]">
            <Server className="mx-auto mb-4 size-8 text-zinc-400" />
            <h2 className="text-2xl font-semibold tracking-tight">
              MCP servers are syncing.
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-zinc-500 dark:text-zinc-400">
              The public market is available, but no published MCP servers match
              this view yet.
            </p>
          </div>
        )}
      </section>

      {!query ? (
        <div className={`mx-auto space-y-12 pb-16 ${mcpContainerClassName}`}>
          {mcpDirectorySections.map((section) => (
            <McpDirectorySection
              description={section.description}
              items={sectionItems({
                filter: section.filter,
                items: directoryItems,
                title: section.title,
              })}
              key={section.title}
              title={section.title}
            />
          ))}
        </div>
      ) : null}

      <McpFaqSection />

      <SourceWeftFooter
        authState={authState}
        containerClassName={mcpContainerClassName}
      />
    </main>
  );
}
