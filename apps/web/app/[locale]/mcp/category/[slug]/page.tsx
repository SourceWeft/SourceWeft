import { McpIcon as McpBrandIcon } from "../../../../_components/site-icons";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { routing } from "../../../../../i18n/routing";

import { resolveInitialLandingAuthState } from "../../../../_landing/auth-state-server";
import { SourceWeftFooter } from "../../../../_landing/components/sourceweft-footer";
import { SourceWeftHeader } from "../../../../_landing/components/sourceweft-header";
import { JsonLd } from "../../../../_components/seo/json-ld";
import {
  isIndexableListing,
  NO_INDEX_METADATA,
  OG_IMAGE,
  SITE_NAME,
  SITE_URL,
} from "../../../../seo";
import {
  countPublicMcpByCategory,
  listPublicMcp,
  requirePublicMcpCategories,
} from "../../../../../lib/market-mcp";
import {
  mcpCountRequest,
  mcpListRequest,
  parseMcpBrowseState,
  type McpSearchParams,
} from "../../_components/mcp-browse";
import { McpListingView, McpSearchForm } from "../../_components/mcp-listing";
import {
  mcpCategoryPath,
  mcpContainerClassName,
  mcpPath,
} from "../../_components/mcp-display";

// Canonical and JSON-LD embed the public site URL, which is injected at
// container start, so this must never be prerendered at build time.
export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ locale: string; slug: string }>;
  searchParams: Promise<McpSearchParams>;
};

async function loadCategory(slug: string) {
  // Throws on a market outage so the page 5xxs rather than 404ing every
  // category at once.
  const { items } = await requirePublicMcpCategories();
  return items.find((category) => category.slug === slug) ?? null;
}

export async function generateMetadata({
  params,
  searchParams,
}: PageProps): Promise<Metadata> {
  const { locale, slug } = await params;
  const t = await getTranslations({ locale, namespace: "mcp.category" });
  const decodedSlug = decodeURIComponent(slug);
  const category = await loadCategory(decodedSlug);

  if (!category) {
    return { ...NO_INDEX_METADATA, title: t("notFound") };
  }

  const state = parseMcpBrowseState(await searchParams, {
    category: category.slug,
  });
  const title = t("title", { name: category.name });
  const description =
    category.description ?? t("descriptionTemplate", { name: category.name });
  const url = `${SITE_URL}${mcpCategoryPath(category.slug)}`;
  const market = await listPublicMcp({
    category: category.slug,
    includeDesktopOnly: true,
  });
  // A search or facet inside the category is one of infinitely many views of
  // the same page, so only the bare category URL is offered for indexing.
  const narrowed =
    Boolean(state.query) ||
    Boolean(state.cursor) ||
    state.trust !== "all" ||
    state.runtime !== "all";

  return {
    alternates: { canonical: url },
    description,
    openGraph: {
      description,
      images: [OG_IMAGE],
      siteName: SITE_NAME,
      title,
      type: "website",
      url,
    },
    ...(!narrowed && isIndexableListing(market.items.length)
      ? {}
      : NO_INDEX_METADATA),
    title,
    twitter: {
      card: "summary_large_image",
      description,
      images: [OG_IMAGE.url],
      title,
    },
  };
}

export default async function PublicMcpCategoryPage({
  params,
  searchParams,
}: PageProps) {
  const [{ locale, slug }, rawSearchParams] = await Promise.all([
    params,
    searchParams,
  ]);
  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }
  setRequestLocale(locale);
  const t = await getTranslations("mcp.category");
  const decodedSlug = decodeURIComponent(slug);
  const [authState, category, categoriesResponse] = await Promise.all([
    resolveInitialLandingAuthState(),
    loadCategory(decodedSlug),
    requirePublicMcpCategories(),
  ]);

  if (!category) {
    notFound();
  }

  const state = parseMcpBrowseState(rawSearchParams, {
    category: category.slug,
  });
  const [facets, market] = await Promise.all([
    countPublicMcpByCategory(mcpCountRequest(state)),
    listPublicMcp(mcpListRequest(state)),
  ]);
  const description =
    category.description ?? t("bodyDescription", { name: category.name });
  const breadcrumbJsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", item: SITE_URL, name: "Home", position: 1 },
      {
        "@type": "ListItem",
        item: `${SITE_URL}/mcp`,
        name: "MCP Servers",
        position: 2,
      },
      {
        "@type": "ListItem",
        item: `${SITE_URL}${mcpCategoryPath(category.slug)}`,
        name: t("title", { name: category.name }),
        position: 3,
      },
    ],
  };
  const itemListJsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: market.items.map((item, index) => ({
      "@type": "ListItem",
      name: item.name,
      position: index + 1,
      url: `${SITE_URL}${mcpPath(item.identifier)}`,
    })),
  };

  return (
    <main className="min-h-svh bg-[#f7f4ed] text-zinc-950 dark:bg-zinc-950 dark:text-white">
      <JsonLd data={breadcrumbJsonLd} />
      <JsonLd data={itemListJsonLd} />
      <SourceWeftHeader
        authState={authState}
        containerClassName={mcpContainerClassName}
      />

      <section className="relative overflow-hidden border-b border-zinc-300 dark:border-white/10">
        <div
          aria-hidden
          className="absolute inset-0 bg-[linear-gradient(rgba(24,24,27,0.055)_1px,transparent_1px),linear-gradient(90deg,rgba(24,24,27,0.055)_1px,transparent_1px)] bg-[size:42px_42px] dark:bg-[linear-gradient(rgba(255,255,255,0.045)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.045)_1px,transparent_1px)]"
        />
        <div className={`relative mx-auto pb-8 pt-24 ${mcpContainerClassName}`}>
          <Link
            className="mb-8 inline-flex items-center gap-2 text-sm text-zinc-500 transition-colors hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-white"
            href="/mcp"
          >
            <ArrowLeft className="size-4" />
            {t("backToMarket")}
          </Link>
          <div className="max-w-4xl">
            <span className="mb-5 inline-flex items-center gap-2 rounded-full border border-zinc-300 bg-white/48 px-3 py-1 text-xs font-medium text-zinc-600 dark:border-white/10 dark:bg-white/[0.04] dark:text-zinc-400">
              <McpBrandIcon className="size-3.5" />
              {category.name}
            </span>
            <h1 className="text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
              {t("title", { name: category.name })}
            </h1>
            <p className="mt-4 max-w-2xl text-base leading-7 text-zinc-600 dark:text-zinc-300">
              {description}
            </p>
          </div>

          <McpSearchForm
            action={mcpCategoryPath(category.slug)}
            className="mt-6"
            state={state}
          />
        </div>
      </section>

      <McpListingView
        categories={categoriesResponse.items}
        counts={facets.counts}
        market={market}
        state={state}
        title={
          state.query
            ? t("resultsIn", { query: state.query, category: category.name })
            : undefined
        }
        total={facets.total}
      />

      <SourceWeftFooter
        authState={authState}
        containerClassName={mcpContainerClassName}
      />
    </main>
  );
}
