import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Server } from "lucide-react";

import { resolveInitialLandingAuthState } from "../../../_landing/auth-state-server";
import { SourceWeftFooter } from "../../../_landing/components/sourceweft-footer";
import { SourceWeftHeader } from "../../../_landing/components/sourceweft-header";
import { JsonLd } from "../../../_components/seo/json-ld";
import {
  isIndexableListing,
  NO_INDEX_METADATA,
  OG_IMAGE,
  SITE_NAME,
  SITE_URL,
} from "../../../seo";
import {
  listPublicMcp,
  requirePublicMcpCategories,
} from "../../../../lib/market-mcp";
import {
  mcpCategoryPath,
  mcpContainerClassName,
  McpMarketCard,
} from "../../_components/mcp-display";

// Canonical and JSON-LD embed the public site URL, which is injected at
// container start, so this must never be prerendered at build time.
export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ slug: string }>;
};

async function loadCategory(slug: string) {
  // Throws on a market outage so the page 5xxs rather than 404ing every
  // category at once.
  const { items } = await requirePublicMcpCategories();
  return items.find((category) => category.slug === slug) ?? null;
}

function categoryTitle(name: string) {
  return `${name} MCP Servers`;
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const decodedSlug = decodeURIComponent(slug);
  const category = await loadCategory(decodedSlug);

  if (!category) {
    return { ...NO_INDEX_METADATA, title: "MCP Category" };
  }

  const title = categoryTitle(category.name);
  const description =
    category.description ??
    `Browse public ${category.name} MCP servers with tools, transport, runtime, and verification details.`;
  const url = `${SITE_URL}${mcpCategoryPath(category.slug)}`;
  const market = await listPublicMcp({
    category: category.slug,
    includeDesktopOnly: true,
  });

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
    ...(isIndexableListing(market.items.length) ? {} : NO_INDEX_METADATA),
    title,
    twitter: {
      card: "summary_large_image",
      description,
      images: [OG_IMAGE.url],
      title,
    },
  };
}

export default async function PublicMcpCategoryPage({ params }: PageProps) {
  const { slug } = await params;
  const decodedSlug = decodeURIComponent(slug);
  const [authState, category] = await Promise.all([
    resolveInitialLandingAuthState(),
    loadCategory(decodedSlug),
  ]);

  if (!category) {
    notFound();
  }

  const market = await listPublicMcp({
    category: category.slug,
    includeDesktopOnly: true,
  });
  const description =
    category.description ??
    `Public ${category.name} MCP servers available to SourceWeft and other MCP clients.`;
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
        name: categoryTitle(category.name),
        position: 3,
      },
    ],
  };

  return (
    <main className="min-h-svh bg-[#f7f4ed] text-zinc-950 dark:bg-zinc-950 dark:text-white">
      <JsonLd data={breadcrumbJsonLd} />
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
          className={`relative mx-auto pb-12 pt-24 lg:pb-16 lg:pt-28 ${mcpContainerClassName}`}
        >
          <Link
            className="mb-8 inline-flex items-center gap-2 text-sm text-zinc-500 transition-colors hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-white"
            href="/mcp"
          >
            <ArrowLeft className="size-4" />
            Back to MCP market
          </Link>
          <div className="max-w-4xl">
            <span className="mb-6 inline-flex items-center gap-2 rounded-full border border-zinc-300 bg-white/48 px-3 py-1 text-xs font-medium text-zinc-600 dark:border-white/10 dark:bg-white/[0.04] dark:text-zinc-400">
              <Server className="size-3.5" />
              {category.name}
            </span>
            <h1 className="text-5xl font-semibold leading-[0.95] tracking-tight text-zinc-950 sm:text-6xl dark:text-white">
              {categoryTitle(category.name)}
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-zinc-600 dark:text-zinc-300">
              {description}
            </p>
          </div>
        </div>
      </section>

      <section className={`mx-auto py-12 ${mcpContainerClassName}`}>
        {market.items.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            No MCP servers are listed in this category yet.{" "}
            <Link className="underline underline-offset-4" href="/mcp">
              Browse all MCP servers
            </Link>
            .
          </p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {market.items.map((item) => (
              <McpMarketCard item={item} key={item.identifier} />
            ))}
          </div>
        )}
      </section>

      <SourceWeftFooter
        authState={authState}
        containerClassName={mcpContainerClassName}
      />
    </main>
  );
}
