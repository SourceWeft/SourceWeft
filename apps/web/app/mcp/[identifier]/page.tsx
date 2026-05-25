import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  Boxes,
  Code2,
  KeyRound,
  Layers3,
  LockKeyhole,
  Server,
} from "lucide-react";

import { resolveInitialLandingAuthState } from "../../_landing/auth-state-server";
import { SourceWeftFooter } from "../../_landing/components/sourceweft-footer";
import { SourceWeftHeader } from "../../_landing/components/sourceweft-header";
import { SITE_NAME, SITE_URL } from "../../seo";
import {
  getPublicMcpManifest,
  isMarketNotFound,
  listPublicMcp,
} from "../../../lib/market-mcp";
import {
  ExternalTextLink,
  formatDate,
  mcpContainerClassName,
  mcpPath,
  McpLogoMark,
  McpMarketCard,
  McpRuntimeBadge,
  McpToolRows,
  McpTransportBadge,
  McpVerificationBadge,
  mcpDetailSeoDescription,
  mcpFaqItems,
  publicMcpDescription,
  runtimeLabel,
  transportLabel,
  verificationLabel,
} from "../_components/mcp-display";

export const revalidate = 3600;

type PageProps = {
  params: Promise<{ identifier: string }>;
};

async function loadMcp(identifier: string) {
  try {
    return await getPublicMcpManifest(identifier);
  } catch (error) {
    if (isMarketNotFound(error)) {
      notFound();
    }
    notFound();
  }
}

function relatedMcpItems(input: {
  currentIdentifier: string;
  items: Awaited<ReturnType<typeof listPublicMcp>>["items"];
  categories: string[];
  runtime: string;
  transport: string;
}) {
  const categorySet = new Set(input.categories.map((category) => category.toLowerCase()));
  return input.items
    .filter((item) => item.identifier !== input.currentIdentifier)
    .map((item) => {
      const categoryScore = item.categories.filter((category) =>
        categorySet.has(category.toLowerCase()),
      ).length;
      const runtimeScore = item.runtime === input.runtime ? 1 : 0;
      const transportScore = item.transport === input.transport ? 1 : 0;
      return {
        item,
        score: categoryScore * 4 + runtimeScore + transportScore,
      };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 3)
    .map((entry) => entry.item);
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { identifier } = await params;
  try {
    const result = await loadMcp(decodeURIComponent(identifier));
    const title = `${result.item.name} MCP Server`;
    const description = mcpDetailSeoDescription(result);
    const url = `${SITE_URL}${mcpPath(result.item.identifier)}`;
    return {
      alternates: { canonical: url },
      description,
      openGraph: {
        description,
        siteName: SITE_NAME,
        title,
        type: "article",
        url,
      },
      title,
    };
  } catch {
    return {
      title: "MCP Server",
    };
  }
}

export default async function PublicMcpDetailPage({ params }: PageProps) {
  const { identifier } = await params;
  const decodedIdentifier = decodeURIComponent(identifier);
  const [authState, result] = await Promise.all([
    resolveInitialLandingAuthState(),
    loadMcp(decodedIdentifier),
  ]);
  const { item, manifest, version } = result;
  const relatedMarket = await listPublicMcp({
    includeDesktopOnly: true,
    limit: 100,
  });
  const relatedItems = relatedMcpItems({
    categories: item.categories,
    currentIdentifier: item.identifier,
    items: relatedMarket.items,
    runtime: item.runtime,
    transport: manifest.transport,
  });
  const trusted = Boolean(item.official || item.verified);
  const description = publicMcpDescription({ item, manifest });
  const sourceUrl = manifest.sourceUrl ?? item.sourceUrl;
  const repoUrl = manifest.repoUrl ?? item.repoUrl;
  const homepageUrl = manifest.homepageUrl ?? item.homepageUrl;
  const installHref = authState.isSignedIn
    ? `/dashboard/mcp?mcp=${encodeURIComponent(item.identifier)}`
    : "/auth/sign-in";
  const softwareJsonLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    applicationCategory: "DeveloperApplication",
    description,
    isAccessibleForFree: true,
    name: `${item.name} MCP Server`,
    operatingSystem:
      item.runtime === "desktop" ? "Desktop MCP client" : "Web MCP client",
    provider: {
      "@type": "Organization",
      name: item.providerName ?? manifest.providerName ?? "SourceWeft MCP Market",
    },
    sameAs: [homepageUrl, repoUrl, sourceUrl].filter(Boolean),
    softwareVersion: version.version,
    url: `${SITE_URL}${mcpPath(item.identifier)}`,
  };
  const breadcrumbJsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      {
        "@type": "ListItem",
        item: SITE_URL,
        name: "Home",
        position: 1,
      },
      {
        "@type": "ListItem",
        item: `${SITE_URL}/mcp`,
        name: "MCP Servers",
        position: 2,
      },
      {
        "@type": "ListItem",
        item: `${SITE_URL}${mcpPath(item.identifier)}`,
        name: `${item.name} MCP Server`,
        position: 3,
      },
    ],
  };
  const faqJsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: mcpFaqItems.slice(0, 3).map((faqItem) => ({
      "@type": "Question",
      acceptedAnswer: {
        "@type": "Answer",
        text: faqItem.answer,
      },
      name: faqItem.question,
    })),
  };

  return (
    <main className="min-h-svh bg-[#f7f4ed] text-zinc-950 dark:bg-zinc-950 dark:text-white">
      <script
        dangerouslySetInnerHTML={{ __html: JSON.stringify(softwareJsonLd) }}
        type="application/ld+json"
      />
      <script
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbJsonLd) }}
        type="application/ld+json"
      />
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
        <div className={`relative mx-auto pb-10 pt-24 lg:pb-12 lg:pt-28 ${mcpContainerClassName}`}>
          <Link
            className="mb-8 inline-flex items-center gap-2 text-sm text-zinc-500 transition-colors hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-white"
            href="/mcp"
          >
            <ArrowLeft className="size-4" />
            Back to MCP market
          </Link>

          <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_330px] lg:items-end">
            <div>
              <div className="mb-6 flex items-center gap-4">
                <McpLogoMark size="lg" trusted={trusted} />
                <div className="min-w-0">
                  <p className="text-sm text-zinc-500 dark:text-zinc-400">
                    {item.providerName ?? manifest.providerName ?? item.identifier}
                  </p>
                  <h1 className="mt-1 max-w-4xl text-5xl font-semibold leading-[0.95] tracking-tight text-zinc-950 sm:text-6xl dark:text-white">
                    {item.name} MCP Server
                  </h1>
                </div>
              </div>
              <p className="max-w-3xl text-lg leading-8 text-zinc-600 dark:text-zinc-300">
                {description}
              </p>
              <div className="mt-6 flex flex-wrap gap-2">
                <McpVerificationBadge item={item} />
                <McpRuntimeBadge item={item} />
                <McpTransportBadge transport={manifest.transport} />
              </div>
            </div>

            <aside className="rounded-lg border border-zinc-300 bg-white/62 p-4 dark:border-white/10 dark:bg-white/[0.04]">
              <dl className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <dt className="text-xs text-zinc-500 dark:text-zinc-500">
                    Version
                  </dt>
                  <dd className="mt-1 font-medium">{version.version}</dd>
                </div>
                <div>
                  <dt className="text-xs text-zinc-500 dark:text-zinc-500">
                    Tools
                  </dt>
                  <dd className="mt-1 font-medium">{manifest.tools.length}</dd>
                </div>
                <div>
                  <dt className="text-xs text-zinc-500 dark:text-zinc-500">
                    Updated
                  </dt>
                  <dd className="mt-1 font-medium">
                    {formatDate(item.updatedAt)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-zinc-500 dark:text-zinc-500">
                    Auth
                  </dt>
                  <dd className="mt-1 font-medium">
                    {manifest.auth.required ? "Required" : "Optional"}
                  </dd>
                </div>
              </dl>
              <Link
                className="mt-5 inline-flex h-10 w-full items-center justify-center rounded-lg bg-zinc-950 px-4 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-100"
                href={installHref}
              >
                {authState.isSignedIn ? "Open in Dashboard" : "Sign in to use"}
              </Link>
            </aside>
          </div>
        </div>
      </section>

      <section className={`mx-auto grid gap-8 py-10 lg:grid-cols-[minmax(0,1fr)_340px] ${mcpContainerClassName}`}>
        <div className="space-y-8">
          <section>
            <div className="mb-4 flex items-center gap-2">
              <Code2 className="size-4 text-zinc-400" />
              <h2 className="text-2xl font-semibold tracking-tight">Tools</h2>
            </div>
            <McpToolRows tools={manifest.tools} />
          </section>

          <section className="rounded-lg border border-zinc-300 bg-white/58 p-5 dark:border-white/10 dark:bg-white/[0.03]">
            <div className="mb-4 flex items-center gap-2">
              <Boxes className="size-4 text-zinc-400" />
              <h2 className="text-2xl font-semibold tracking-tight">
                Installation
              </h2>
            </div>
            <div className="space-y-4 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
              <p>
                This listing is a public directory entry. Workspace installation,
                credential storage, testing, and execution happen inside the
                SourceWeft dashboard.
              </p>
              <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4 dark:border-white/10 dark:bg-white/[0.03]">
                <p className="font-medium text-zinc-950 dark:text-white">
                  Runtime
                </p>
                <p className="mt-1">
                  {runtimeLabel(item)} via {transportLabel(manifest.transport)}.
                  {manifest.transport === "stdio"
                    ? " STDIO servers require a desktop MCP host."
                    : " HTTP/SSE servers can be executed from the web runtime when configured in a workspace."}
                </p>
              </div>
              {manifest.auth.required ? (
                <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4 dark:border-white/10 dark:bg-white/[0.03]">
                  <p className="inline-flex items-center gap-2 font-medium text-zinc-950 dark:text-white">
                    <KeyRound className="size-4" />
                    Credentials required
                  </p>
                  <p className="mt-1">
                    {manifest.auth.displayName ?? manifest.auth.type} credentials
                    are configured privately in the dashboard and are never shown
                    on this public page.
                  </p>
                </div>
              ) : null}
            </div>
          </section>
        </div>

        <aside className="space-y-5">
          <section className="rounded-lg border border-zinc-300 bg-white/58 p-5 dark:border-white/10 dark:bg-white/[0.03]">
            <div className="mb-4 flex items-center gap-2">
              <Server className="size-4 text-zinc-400" />
              <h2 className="text-lg font-semibold">Server details</h2>
            </div>
            <dl className="space-y-3 text-sm">
              {[
                ["Identifier", item.identifier],
                ["Transport", transportLabel(manifest.transport)],
                ["Runtime", runtimeLabel(item)],
                ["Trust", verificationLabel(item)],
                ["License", manifest.license ?? item.license ?? "Unknown"],
                ["Language", manifest.language ?? item.language ?? "Unknown"],
              ].map(([label, value]) => (
                <div
                  className="flex items-start justify-between gap-4 border-b border-zinc-200 pb-3 last:border-0 last:pb-0 dark:border-white/10"
                  key={label}
                >
                  <dt className="text-zinc-500 dark:text-zinc-500">{label}</dt>
                  <dd className="min-w-0 text-right font-medium text-zinc-950 dark:text-white">
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
            <div className="mt-5 flex flex-col gap-2">
              <ExternalTextLink href={homepageUrl}>Homepage</ExternalTextLink>
              <ExternalTextLink href={repoUrl}>Repository</ExternalTextLink>
              <ExternalTextLink href={sourceUrl}>Source</ExternalTextLink>
            </div>
          </section>

          <section className="rounded-lg border border-amber-200 bg-amber-50 p-5 text-sm leading-6 text-amber-800 dark:border-amber-300/20 dark:bg-amber-300/10 dark:text-amber-100">
            <div className="mb-2 flex items-center gap-2 font-semibold">
              {trusted ? (
                <LockKeyhole className="size-4" />
              ) : (
                <AlertTriangle className="size-4" />
              )}
              Security note
            </div>
            <p>
              MCP servers can receive tool arguments from a conversation and may
              perform external actions. Unverified listings are allowed, but
              SourceWeft marks them so workspace users can review the server
              before enabling it.
            </p>
          </section>

          {item.categories.length > 0 ? (
            <section className="rounded-lg border border-zinc-300 bg-white/58 p-5 dark:border-white/10 dark:bg-white/[0.03]">
              <div className="mb-3 flex items-center gap-2">
                <Layers3 className="size-4 text-zinc-400" />
                <h2 className="text-lg font-semibold">Categories</h2>
              </div>
              <div className="flex flex-wrap gap-2">
                {item.categories.map((category) => (
                  <span
                    className="rounded-full border border-zinc-300 bg-white/70 px-3 py-1 text-xs text-zinc-600 dark:border-white/10 dark:bg-white/[0.04] dark:text-zinc-300"
                    key={category}
                  >
                    {category}
                  </span>
                ))}
              </div>
            </section>
          ) : null}
        </aside>
      </section>

      {relatedItems.length > 0 ? (
        <section className={`mx-auto pb-16 ${mcpContainerClassName}`}>
          <div className="border-t border-zinc-300 pt-10 dark:border-white/10">
            <div className="mb-6">
              <p className="text-xs font-semibold uppercase text-zinc-400">
                Related MCP servers
              </p>
              <h2 className="mt-2 text-3xl font-semibold tracking-tight">
                More servers like {item.name}
              </h2>
            </div>
            <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
              {relatedItems.map((relatedItem) => (
                <McpMarketCard
                  item={relatedItem}
                  key={relatedItem.identifier}
                />
              ))}
            </div>
          </div>
        </section>
      ) : null}

      <SourceWeftFooter
        authState={authState}
        containerClassName={mcpContainerClassName}
      />
    </main>
  );
}

export async function generateStaticParams() {
  const market = await listPublicMcp({ limit: 100 });
  return market.items.map((item) => ({ identifier: item.identifier }));
}
