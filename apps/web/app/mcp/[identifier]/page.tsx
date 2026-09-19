import { McpIcon as McpBrandIcon } from "../../_components/site-icons";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  AlertTriangle,
  ChevronRight,
  Code2,
  History,
  KeyRound,
  LockKeyhole,
} from "lucide-react";
import type { MarketItemSummary } from "@sourceweft/market-sdk";

import { resolveInitialLandingAuthState } from "../../_landing/auth-state-server";
import { SourceWeftFooter } from "../../_landing/components/sourceweft-footer";
import { SourceWeftHeader } from "../../_landing/components/sourceweft-header";
import { JsonLd } from "../../_components/seo/json-ld";
import { OG_IMAGE, SITE_NAME, SITE_URL } from "../../seo";
import {
  getPublicMcpManifest,
  getPublicMcpVersions,
  isMarketNotFound,
  listPublicMcp,
  listPublicMcpCategories,
} from "../../../lib/market-mcp";
import { CopyButton, McpIcon } from "../_components/mcp-client";
import {
  ExternalTextLink,
  formatDate,
  McpCardGrid,
  mcpCategoryLabel,
  mcpCategoryNames,
  mcpContainerClassName,
  mcpDetailSeoDescription,
  mcpPath,
  McpRuntimeBadge,
  McpToolRows,
  McpTransportBadge,
  McpVerificationBadge,
  publicMcpDescription,
  runtimeLabel,
  transportLabel,
  verificationLabel,
} from "../_components/mcp-display";
import { remoteMcpClientConfig } from "../_components/mcp-install";

// Not build-time prerendered: canonical/JSON-LD embed the public site URL, which
// is injected at container start, so a build-time render would bake in the
// wrong origin. Freshness now comes from the cached market reads instead.
export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ identifier: string }>;
};

async function loadMcp(identifier: string) {
  try {
    return await getPublicMcpManifest(identifier);
  } catch (error) {
    // A market outage must surface as 5xx: 404 would deindex every server page.
    if (isMarketNotFound(error)) {
      notFound();
    }
    throw error;
  }
}

function relatedMcpItems(input: {
  currentIdentifier: string;
  items: MarketItemSummary[];
  categories: string[];
  runtime: string;
  transport: string;
}) {
  const categorySet = new Set(input.categories);
  return input.items
    .filter((item) => item.identifier !== input.currentIdentifier)
    .map((item) => ({
      item,
      score:
        item.categories.filter((category) => categorySet.has(category)).length * 4 +
        (item.runtime === input.runtime ? 1 : 0) +
        (item.transport === input.transport ? 1 : 0) +
        (item.official || item.verified ? 1 : 0),
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, 3)
    .map((entry) => entry.item);
}

function SectionHeading({
  children,
  count,
  icon: Icon,
}: {
  children: React.ReactNode;
  count?: number;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <div className="mb-4 flex items-center gap-2">
      <Icon className="size-4 text-zinc-400" />
      <h2 className="text-xl font-semibold tracking-tight">{children}</h2>
      {count !== undefined ? (
        <span className="rounded-full bg-zinc-200 px-2 py-0.5 text-xs tabular-nums text-zinc-600 dark:bg-white/10 dark:text-zinc-300">
          {count}
        </span>
      ) : null}
    </div>
  );
}

const panelClassName =
  "rounded-xl border border-zinc-300 bg-white/58 p-5 dark:border-white/10 dark:bg-white/[0.03]";

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
        images: [OG_IMAGE],
        siteName: SITE_NAME,
        title,
        type: "article",
        url,
      },
      title,
      twitter: {
        card: "summary_large_image",
        description,
        images: [OG_IMAGE.url],
        title,
      },
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
  const [authState, result, versions, categoriesResponse] = await Promise.all([
    resolveInitialLandingAuthState(),
    loadMcp(decodedIdentifier),
    getPublicMcpVersions(decodedIdentifier),
    listPublicMcpCategories(),
  ]);
  const { item, manifest, version } = result;
  const categoryNames = mcpCategoryNames(categoriesResponse.items);
  const relatedMarket =
    item.categories.length > 0
      ? await listPublicMcp({
          category: item.categories.join(","),
          includeDesktopOnly: true,
          limit: 12,
        })
      : { items: [] };
  const relatedItems = relatedMcpItems({
    categories: item.categories,
    currentIdentifier: item.identifier,
    items: relatedMarket.items,
    runtime: item.runtime,
    transport: manifest.transport,
  });
  const trusted = Boolean(item.official || item.verified);
  const description = publicMcpDescription({ item, manifest });
  const providerName = item.providerName ?? manifest.providerName;
  const sourceUrl = manifest.sourceUrl ?? item.sourceUrl;
  const repoUrl = manifest.repoUrl ?? item.repoUrl;
  const homepageUrl = manifest.homepageUrl ?? item.homepageUrl;
  const clientConfig = remoteMcpClientConfig(manifest);
  // The hero already shows the summary; only a longer description adds anything.
  const overviewText =
    manifest.description && manifest.description !== item.summary
      ? manifest.description
      : null;
  const hasOverview = Boolean(overviewText || manifest.riskSummary);
  const primaryCategory = item.categories[0];
  const installHref = authState.isSignedIn
    ? `/dashboard/mcp?mcp=${encodeURIComponent(item.identifier)}`
    : "/auth/sign-in";
  const sectionLinks = [
    ...(hasOverview ? [["overview", "Overview"]] : []),
    ["installation", "Installation"],
    ["tools", `Tools (${manifest.tools.length})`],
    ...(versions.length > 0 ? [["versions", `Versions (${versions.length})`]] : []),
    ...(relatedItems.length > 0 ? [["related", "Related"]] : []),
  ];
  const softwareJsonLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    applicationCategory: "DeveloperApplication",
    description,
    isAccessibleForFree: true,
    name: `${item.name} MCP Server`,
    offers: {
      "@type": "Offer",
      price: 0,
      priceCurrency: "USD",
    },
    operatingSystem: item.runtime === "desktop" ? "Windows, macOS, Linux" : "Web",
    provider: {
      "@type": "Organization",
      name: providerName ?? "SourceWeft MCP Market",
    },
    sameAs: [homepageUrl, repoUrl, sourceUrl].filter(Boolean),
    softwareVersion: version.version,
    url: `${SITE_URL}${mcpPath(item.identifier)}`,
  };
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
        item: `${SITE_URL}${mcpPath(item.identifier)}`,
        name: `${item.name} MCP Server`,
        position: 3,
      },
    ],
  };
  return (
    <main className="min-h-svh bg-[#f7f4ed] text-zinc-950 dark:bg-zinc-950 dark:text-white">
      <JsonLd data={softwareJsonLd} />
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
        <div className={`relative mx-auto pb-8 pt-24 ${mcpContainerClassName}`}>
          <nav
            aria-label="Breadcrumb"
            className="mb-8 flex min-w-0 items-center gap-1.5 text-sm text-zinc-500 dark:text-zinc-400"
          >
            <Link className="shrink-0 hover:text-zinc-950 dark:hover:text-white" href="/mcp">
              MCP Servers
            </Link>
            {primaryCategory ? (
              <>
                <ChevronRight className="size-3.5 shrink-0" />
                <Link
                  className="shrink-0 hover:text-zinc-950 dark:hover:text-white"
                  href={`/mcp?category=${encodeURIComponent(primaryCategory)}`}
                >
                  {mcpCategoryLabel(primaryCategory, categoryNames)}
                </Link>
              </>
            ) : null}
            <ChevronRight className="size-3.5 shrink-0" />
            <span className="truncate text-zinc-950 dark:text-white">
              {item.identifier}
            </span>
          </nav>

          <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
            <div className="min-w-0">
              <div className="flex items-start gap-4">
                <McpIcon iconUrl={item.iconUrl} size="lg" trusted={trusted} />
                <div className="min-w-0">
                  <h1 className="text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
                    {item.name}
                  </h1>
                  <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-zinc-500 dark:text-zinc-400">
                    {providerName ? (
                      <span className="font-medium text-zinc-700 dark:text-zinc-300">
                        {providerName}
                      </span>
                    ) : null}
                    <span>v{version.version}</span>
                    <span>Updated {formatDate(item.updatedAt)}</span>
                  </p>
                </div>
              </div>
              <p className="mt-6 max-w-3xl text-lg leading-8 text-zinc-600 dark:text-zinc-300">
                {item.summary || description}
              </p>
              <div className="mt-6 flex flex-wrap gap-2">
                <McpVerificationBadge item={item} />
                <McpTransportBadge transport={manifest.transport} />
                <McpRuntimeBadge item={item} />
                {item.categories.map((category) => (
                  <Link
                    className="inline-flex h-6 items-center rounded-full border border-zinc-300 bg-white/70 px-2.5 text-xs font-medium text-zinc-600 transition-colors hover:border-zinc-950 hover:text-zinc-950 dark:border-white/10 dark:bg-white/[0.04] dark:text-zinc-300 dark:hover:border-white/40 dark:hover:text-white"
                    href={`/mcp?category=${encodeURIComponent(category)}`}
                    key={category}
                  >
                    {mcpCategoryLabel(category, categoryNames)}
                  </Link>
                ))}
              </div>
            </div>

            <aside className="rounded-xl border border-zinc-300 bg-white/70 p-5 dark:border-white/10 dark:bg-white/[0.04]">
              <dl className="grid grid-cols-2 gap-4 text-sm">
                {[
                  ["Tools", String(manifest.tools.length)],
                  ["Auth", manifest.auth.required ? "Required" : "Not required"],
                  ["License", manifest.license ?? item.license ?? "Unknown"],
                  ["Language", manifest.language ?? item.language ?? "Unknown"],
                ].map(([label, value]) => (
                  <div className="min-w-0" key={label}>
                    <dt className="text-xs text-zinc-500">{label}</dt>
                    <dd className="mt-1 truncate font-medium">{value}</dd>
                  </div>
                ))}
              </dl>
              <Link
                className="mt-5 inline-flex h-10 w-full items-center justify-center rounded-lg bg-zinc-950 px-4 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-100"
                href={installHref}
              >
                {authState.isSignedIn ? "Add to workspace" : "Sign in to install"}
              </Link>
              <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2">
                <ExternalTextLink href={homepageUrl}>Homepage</ExternalTextLink>
                <ExternalTextLink href={repoUrl}>Repository</ExternalTextLink>
                <ExternalTextLink href={sourceUrl}>Source</ExternalTextLink>
              </div>
            </aside>
          </div>
        </div>
      </section>

      <nav
        aria-label="Sections"
        className="sticky top-14 z-40 border-b border-zinc-300 bg-[#f7f4ed]/90 backdrop-blur-[12px] dark:border-white/10 dark:bg-zinc-950/90"
      >
        <div
          className={`mx-auto flex gap-6 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${mcpContainerClassName}`}
        >
          {sectionLinks.map(([id, label]) => (
            <a
              className="shrink-0 border-b-2 border-transparent py-3 text-sm text-zinc-500 transition-colors hover:border-zinc-950 hover:text-zinc-950 dark:hover:border-white dark:hover:text-white"
              href={`#${id}`}
              key={id}
            >
              {label}
            </a>
          ))}
        </div>
      </nav>

      <div
        className={`mx-auto grid gap-8 py-10 lg:grid-cols-[minmax(0,1fr)_320px] ${mcpContainerClassName}`}
      >
        <div className="min-w-0 space-y-12">
          {hasOverview ? (
            <section className="scroll-mt-32" id="overview">
              <SectionHeading icon={McpBrandIcon}>Overview</SectionHeading>
              <div className={`${panelClassName} space-y-4 divide-y divide-zinc-200 dark:divide-white/10 [&>*:not(:first-child)]:pt-4`}>
                {overviewText ? (
                  <p className="whitespace-pre-line text-sm leading-7 text-zinc-600 dark:text-zinc-300">
                    {overviewText}
                  </p>
                ) : null}
                {manifest.riskSummary ? (
                  <p className="text-sm leading-6 text-zinc-600 dark:text-zinc-400">
                    <span className="font-medium text-zinc-950 dark:text-white">
                      Risk summary:{" "}
                    </span>
                    {manifest.riskSummary}
                  </p>
                ) : null}
              </div>
            </section>
          ) : null}

          <section className="scroll-mt-32" id="installation">
            <SectionHeading icon={KeyRound}>Installation</SectionHeading>
            <div className="space-y-4">
              <div className={panelClassName}>
                <h3 className="font-semibold">In SourceWeft</h3>
                <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
                  <li>
                    Open{" "}
                    <Link
                      className="font-medium text-zinc-950 underline underline-offset-4 dark:text-white"
                      href={installHref}
                    >
                      {item.name} in the dashboard
                    </Link>{" "}
                    and add it to a workspace.
                  </li>
                  {manifest.auth.required ? (
                    <li>
                      Connect {manifest.auth.displayName ?? "the required"}{" "}
                      credentials. They are stored privately and never shown on
                      public pages.
                    </li>
                  ) : null}
                  <li>Enable the server for the chats that should use its tools.</li>
                </ol>
                <p className="mt-4 rounded-lg bg-zinc-100 p-3 text-xs leading-5 text-zinc-600 dark:bg-white/[0.04] dark:text-zinc-400">
                  {runtimeLabel(item)} via {transportLabel(manifest.transport)}.
                  {manifest.transport === "stdio"
                    ? " STDIO servers start a local process, so they need the SourceWeft desktop host."
                    : " Remote servers run from the web runtime once configured in a workspace."}
                </p>
                {manifest.auth.instructions ? (
                  <p className="mt-3 text-xs leading-5 text-zinc-500">
                    {manifest.auth.instructions}
                  </p>
                ) : null}
              </div>

              {clientConfig ? (
                <div className={panelClassName}>
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 className="font-semibold">Other MCP clients</h3>
                      <p className="mt-1 text-xs text-zinc-500">
                        Add this to your client&apos;s <code>mcpServers</code> config.
                        {manifest.auth.type === "oauth"
                          ? " The client completes OAuth sign-in on first connect."
                          : ""}
                      </p>
                    </div>
                    <CopyButton value={clientConfig} />
                  </div>
                  <pre className="mt-4 overflow-x-auto rounded-lg bg-zinc-950 p-4 font-mono text-xs leading-5 text-zinc-100">
                    {clientConfig}
                  </pre>
                </div>
              ) : repoUrl ? (
                <div className={`${panelClassName} text-sm text-zinc-600 dark:text-zinc-400`}>
                  <h3 className="font-semibold text-zinc-950 dark:text-white">
                    Other MCP clients
                  </h3>
                  <p className="mt-2">
                    Follow the launch instructions in the{" "}
                    <ExternalTextLink href={repoUrl}>repository</ExternalTextLink>.
                  </p>
                </div>
              ) : null}
            </div>
          </section>

          <section className="scroll-mt-32" id="tools">
            <SectionHeading count={manifest.tools.length} icon={Code2}>
              Tools
            </SectionHeading>
            <McpToolRows tools={manifest.tools} />
          </section>

          {versions.length > 0 ? (
            <section className="scroll-mt-32" id="versions">
              <SectionHeading count={versions.length} icon={History}>
                Version history
              </SectionHeading>
              <ol className="divide-y divide-zinc-200 overflow-hidden rounded-xl border border-zinc-300 bg-white/58 dark:divide-white/10 dark:border-white/10 dark:bg-white/[0.03]">
                {versions.map((entry) => (
                  <li
                    className="flex items-center justify-between gap-4 px-5 py-3 text-sm"
                    key={entry.version}
                  >
                    <span className="font-mono font-medium">
                      v{entry.version}
                      {entry.version === version.version ? (
                        <span className="ml-2 rounded-full bg-zinc-950 px-2 py-0.5 font-sans text-[11px] text-white dark:bg-white dark:text-zinc-950">
                          Latest
                        </span>
                      ) : null}
                    </span>
                    <span className="text-zinc-500">
                      {entry.publishedAt ? formatDate(entry.publishedAt) : entry.status}
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}
        </div>

        <aside className="space-y-5 lg:sticky lg:top-32 lg:self-start">
          <section className={panelClassName}>
            <h2 className="mb-4 text-base font-semibold">Server details</h2>
            <dl className="space-y-3 text-sm">
              {[
                ["Identifier", item.identifier],
                ["Transport", transportLabel(manifest.transport)],
                ["Runtime", runtimeLabel(item)],
                ["Trust", verificationLabel(item)],
                ["Published", formatDate(item.publishedAt ?? item.createdAt)],
              ].map(([label, value]) => (
                <div
                  className="flex items-start justify-between gap-4 border-b border-zinc-200 pb-3 last:border-0 last:pb-0 dark:border-white/10"
                  key={label}
                >
                  <dt className="shrink-0 text-zinc-500">{label}</dt>
                  <dd className="min-w-0 break-all text-right font-medium">
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
          </section>

          <section className="rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm leading-6 text-amber-800 dark:border-amber-300/20 dark:bg-amber-300/10 dark:text-amber-100">
            <div className="mb-2 flex items-center gap-2 font-semibold">
              {trusted ? (
                <LockKeyhole className="size-4" />
              ) : (
                <AlertTriangle className="size-4" />
              )}
              Security note
            </div>
            <p>
              MCP servers receive tool arguments from a conversation and may
              perform external actions. Unverified listings are allowed, but
              SourceWeft marks them so you can review the server before enabling
              it.
            </p>
          </section>
        </aside>
      </div>

      {relatedItems.length > 0 ? (
        <section
          className={`mx-auto scroll-mt-32 pb-16 ${mcpContainerClassName}`}
          id="related"
        >
          <div className="border-t border-zinc-300 pt-10 dark:border-white/10">
            <h2 className="mb-6 text-2xl font-semibold tracking-tight">
              More servers like {item.name}
            </h2>
            <McpCardGrid categoryNames={categoryNames} items={relatedItems} />
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
