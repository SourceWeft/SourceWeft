import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Server, Upload, Wrench } from "lucide-react";
import type { MarketCategory, MarketItemSummary } from "@sourceweft/market-sdk";

import { cn } from "@sourceweft/ui-web/lib/utils";

import { resolveInitialLandingAuthState } from "../_landing/auth-state-server";
import { SourceWeftFooter } from "../_landing/components/sourceweft-footer";
import { SourceWeftHeader } from "../_landing/components/sourceweft-header";
import { JsonLd } from "../_components/seo/json-ld";
import { NO_INDEX_METADATA, OG_IMAGE, SITE_NAME, SITE_URL } from "../seo";
import {
  countPublicMcpByCategory,
  listPublicMcp,
  listPublicMcpCategories,
} from "../../lib/market-mcp";
import {
  isMcpListView,
  mcpCountRequest,
  mcpListRequest,
  parseMcpBrowseState,
  type McpSearchParams,
} from "./_components/mcp-browse";
import { McpListingView, McpSearchForm } from "./_components/mcp-listing";
import {
  mcpCategoryNames,
  mcpCategoryPath,
  mcpContainerClassName,
  McpDirectorySection,
  mcpFaqItems,
  McpFaqSection,
  mcpPath,
} from "./_components/mcp-display";

export const revalidate = 300;

const HOME_SECTION_SIZE = 6;
const HOME_CATEGORY_SECTIONS = 4;

const MCP_TITLE = "MCP Server Marketplace";
const MCP_DESCRIPTION =
  "Browse public MCP servers for SourceWeft and other MCP clients. Discover HTTP, SSE, and desktop MCP servers with tools, runtime, and verification details.";
const MCP_SOCIAL_DESCRIPTION =
  "A public directory of MCP servers with tools, transport, runtime, and verification details.";

type PageProps = {
  searchParams: Promise<McpSearchParams>;
};

export async function generateMetadata({
  searchParams,
}: PageProps): Promise<Metadata> {
  const state = parseMcpBrowseState(await searchParams);

  return {
    alternates: {
      canonical: `${SITE_URL}/mcp`,
    },
    description: MCP_DESCRIPTION,
    openGraph: {
      description: MCP_SOCIAL_DESCRIPTION,
      images: [OG_IMAGE],
      siteName: SITE_NAME,
      title: MCP_TITLE,
      type: "website",
      url: `${SITE_URL}/mcp`,
    },
    // Search, facet, and paged permutations are infinite and add nothing over
    // the directory itself, so they stay crawlable but out of the index.
    ...(isMcpListView(state) ? NO_INDEX_METADATA : {}),
    title: MCP_TITLE,
    twitter: {
      card: "summary_large_image",
      description: MCP_SOCIAL_DESCRIPTION,
      images: [OG_IMAGE.url],
      title: MCP_TITLE,
    },
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
    listPublicMcp({
      includeDesktopOnly: true,
      limit: HOME_SECTION_SIZE,
      official: true,
    }),
    listPublicMcp({
      includeDesktopOnly: true,
      limit: HOME_SECTION_SIZE,
      verified: true,
    }),
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
  const state = parseMcpBrowseState(params);
  const listView = isMcpListView(state);

  const [facets, market] = await Promise.all([
    countPublicMcpByCategory(mcpCountRequest(state)),
    listView ? listPublicMcp(mcpListRequest(state)) : null,
  ]);
  // Home sections pick the busiest categories, so they wait on the facets.
  const home = listView
    ? null
    : await loadHomeSections({ categories, counts: facets.counts });

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
      <JsonLd data={itemListJsonLd} />
      {listView ? null : <JsonLd data={faqJsonLd} />}
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
                {MCP_TITLE}
              </p>
            ) : (
              <>
                <h1 className="text-5xl font-semibold leading-[0.95] tracking-tight sm:text-6xl lg:text-7xl">
                  {MCP_TITLE}
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

          <McpSearchForm
            action="/mcp"
            className={listView ? "mt-6" : "mt-9"}
            state={state}
          />

          {listView ? null : <GetStartedPanels signedIn={authState.isSignedIn} />}
        </div>
      </section>

      {market ? (
        <McpListingView
          categories={categories}
          counts={facets.counts}
          market={market}
          state={state}
          title={state.query ? `Results for “${state.query}”` : "All MCP servers"}
          total={facets.total}
        />
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
              viewAllHref={mcpCategoryPath(category.slug)}
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
                    href={mcpCategoryPath(category.slug)}
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
