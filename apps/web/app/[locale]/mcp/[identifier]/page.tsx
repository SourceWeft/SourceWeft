import { McpIcon as McpBrandIcon } from "../../../_components/site-icons";
import type { Metadata } from "next";
import { LocaleLink } from "../../_components/locale-link";
import { notFound } from "next/navigation";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { routing } from "../../../../i18n/routing";
import {
  AlertTriangle,
  ChevronRight,
  Code2,
  FileText,
  Gauge,
  History,
  KeyRound,
  Layers,
  LockKeyhole,
} from "lucide-react";
import { MARKET_MCP_TOOL_SOURCE_OWNER_SUBMITTED } from "@sourceweft/market-contracts";
import type {
  MarketItemSummary,
  MarketMcpProductGroup,
} from "@sourceweft/market-sdk";

import { buildTranslatedAlternates } from "../../../../lib/i18n/metadata";
import { mcpOverviewLocale } from "../../../../lib/mcp-ai-overview";
import { mcpDocumentationUrl, publicMcpFacts } from "../../../../lib/mcp-facts";
import { mcpTemplateDescription } from "../../../../lib/mcp-template-description";
import { resolveInitialLandingAuthState } from "../../../_landing/auth-state-server";
import { SourceWeftFooter } from "../../../_landing/components/sourceweft-footer";
import { SourceWeftHeader } from "../../../_landing/components/sourceweft-header";
import { marketingContainerClassName } from "../../../_landing/components/marketing-container";
import { CatalogBadgeSnippet } from "../../../_components/market/catalog-badge-snippet";
import { McpAiOverviewView } from "../../../_components/market/mcp-ai-overview-view";
import {
  McpReadmeRepositoryLink,
  McpReadmeSection,
  McpReadmeSourceLine,
} from "../../../_components/market/mcp-readme-section";
import { JsonLd } from "../../../_components/seo/json-ld";
import {
  NO_INDEX_FOLLOW_METADATA,
  OG_IMAGE,
  SITE_NAME,
  SITE_URL,
} from "../../../seo";
import {
  getPublicMcpDetail,
  getPublicMcpToolRevisions,
  getPublicMcpManifest,
  isMarketNotFound,
  listPublicMcp,
  listPublicMcpCategories,
} from "../../../../lib/market-mcp";
import {
  hasMcpReadmeToShow,
  isLongMcpReadme,
} from "../../../../lib/mcp-readme";
import {
  mcpAuthExplanation,
  mcpAuthMethod,
} from "../../../../lib/mcp-auth-method";
import {
  mcpToolsValidation,
  mcpToolsValidationReasonKey,
} from "../../../../lib/mcp-tools-validation";
import { CopyButton, McpIcon } from "../_components/mcp-client";
import { McpFactsPanel } from "../_components/mcp-facts-panel";
import {
  ExternalTextLink,
  formatDate,
  McpCardGrid,
  mcpCategoryLabel,
  mcpCategoryNames,
  McpClaimedBadge,
  McpDeprecatedBadge,
  mcpDetailSeoDescription,
  mcpPath,
  McpRuntimeBadge,
  McpToolRows,
  McpTransportBadge,
  McpVerificationBadge,
  publicMcpDescription,
  runtimeLabel,
  shortSeoText,
  transportLabel,
  verificationLabel,
} from "../_components/mcp-display";
import { remoteMcpClientConfig } from "../_components/mcp-install";
import { mcpClaimHref } from "../../../../lib/mcp-claims";
import { McpReadmeCollapse } from "../_components/mcp-readme-collapse";
import { McpScoreCard } from "../_components/mcp-score";
import { McpToolChangeLog } from "../_components/mcp-tool-change-log";

// Not build-time prerendered: canonical/JSON-LD embed the public site URL, which
// is injected at container start, so a build-time render would bake in the
// wrong origin. Freshness now comes from the cached market reads instead.
export const dynamic = "force-dynamic";

const MAX_JSON_LD_FEATURES = 50;

type PageProps = {
  params: Promise<{ locale: string; identifier: string }>;
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
        item.categories.filter((category) => categorySet.has(category)).length *
          4 +
        (item.runtime === input.runtime ? 1 : 0) +
        (item.transport === input.transport ? 1 : 0) +
        (item.official || item.verified ? 1 : 0),
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, 3)
    .map((entry) => entry.item);
}

/**
 * The brand of a product group as a heading word: the slug label with each
 * hyphenated part capitalised, "notion" → "Notion", "claw-link" → "Claw-Link".
 * Deterministic, so every member page names the group the same way.
 */
export function productBrandLabel(brand: string) {
  return brand
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("-");
}

/**
 * What a page shows of its product group (#367 W8): the other members, the
 * product's own server when this page is not it, and the heading brand.
 */
export function productGroupView(
  group: MarketMcpProductGroup | null,
  currentIdentifier: string,
) {
  if (!group) {
    return null;
  }
  const others = group.members.filter(
    (member) => member.identifier !== currentIdentifier,
  );
  const official =
    group.officialIdentifier === currentIdentifier
      ? null
      : (group.members.find(
          (member) => member.identifier === group.officialIdentifier,
        ) ?? null);
  return { brand: productBrandLabel(group.brand), official, others };
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

/**
 * The search description of a page without an AI overview: the template
 * sentence built from the server's facts, unless the registry summary is
 * longer, in which case "{name}: {summary}".
 */
function mcpNoOverviewDescription(
  result: Awaited<ReturnType<typeof loadMcp>>,
  tTemplate: Parameters<typeof mcpTemplateDescription>[1],
  withName: (summary: string) => string,
) {
  const template = mcpTemplateDescription(publicMcpFacts(result), tTemplate);
  const summary = result.item.summary.trim();
  return shortSeoText(
    summary.length > template.length ? withName(summary) : template,
  );
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { locale, identifier } = await params;
  try {
    const decodedIdentifier = decodeURIComponent(identifier);
    const pageLocale = hasLocale(routing.locales, locale)
      ? locale
      : routing.defaultLocale;
    const [result, detail, t, tTemplate] = await Promise.all([
      loadMcp(decodedIdentifier),
      // The same cached read as the page body's.
      getPublicMcpDetail(decodedIdentifier, mcpOverviewLocale(pageLocale)),
      getTranslations({ locale: pageLocale, namespace: "mcp.detail" }),
      getTranslations({ locale: pageLocale, namespace: "mcp.template" }),
    ]);
    const name = result.item.name;
    const title = t("metaTitle", { name });
    // A translated page describes itself with its own overview; any other
    // page with an overview is, or canonicalizes to, the English one and
    // keeps its template. Without an AI overview (#367 W4), the description
    // is the deterministic template sentence — or the registry summary where
    // that is longer — so a page the overview rule skipped still says what
    // the server is instead of a generic phrase.
    const overview = detail.aiOverview;
    const description = !overview
      ? mcpNoOverviewDescription(result, tTemplate, (summary) =>
          t("metaDescriptionOverview", { name, summary }),
        )
      : pageLocale !== routing.defaultLocale && overview.locale === pageLocale
        ? shortSeoText(
            t("metaDescriptionOverview", { name, summary: overview.summary }),
          )
        : mcpDetailSeoDescription(result);
    // The body is the registry's English; a locale counts as its own page only
    // where the server has a visible AI overview written in it, as for skills.
    const alternates = buildTranslatedAlternates(
      mcpPath(result.item.identifier),
      pageLocale,
      detail.overviewLocales,
    );
    const url = alternates.canonical;
    return {
      alternates,
      // Issue #269: one English search-snippet experiment. Social descriptions
      // retain the existing template; registry content and other pages do too.
      description:
        locale === "en" &&
        decodedIdentifier === "io.github.paeyoungpark-web/lupa-mcp" &&
        result.item.identifier === "io.github.paeyoungpark-web/lupa-mcp"
          ? "Lupa MCP lets AI assistants search local Mac files and read indexed document text. Supports PDF, Office and HWP/HWPX files. Requires the Lupa macOS app."
          : description,
      openGraph: {
        description,
        images: [OG_IMAGE],
        siteName: SITE_NAME,
        title,
        type: "article",
        url,
      },
      // The README is one file many servers show (left out of the sitemap too).
      ...(detail.searchIndexable === false ? NO_INDEX_FOLLOW_METADATA : {}),
      title,
      twitter: {
        card: "summary_large_image",
        description,
        images: [OG_IMAGE.url],
        title,
      },
    };
  } catch {
    const t = await getTranslations({ locale, namespace: "mcp.detail" });
    return {
      title: t("metaFallback"),
    };
  }
}

export default async function PublicMcpDetailPage({ params }: PageProps) {
  const { locale, identifier } = await params;
  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }
  setRequestLocale(locale);
  const t = await getTranslations("mcp.detail");
  const tAuth = await getTranslations("mcp.authMethod");
  const tValidation = await getTranslations("mcp.toolsValidation");
  const tScore = await getTranslations("mcp.score");
  const decodedIdentifier = decodeURIComponent(identifier);
  // AI text in the visitor's language, English when there is none in it.
  const overviewLocale = mcpOverviewLocale(locale);
  const [
    authState,
    result,
    { aiOverview, readme, relatedProduct, score, toolsRevision, versions },
    categoriesResponse,
  ] = await Promise.all([
    resolveInitialLandingAuthState(),
    loadMcp(decodedIdentifier),
    getPublicMcpDetail(decodedIdentifier, overviewLocale),
    listPublicMcpCategories(locale),
  ]);
  const { item, manifest, version } = result;
  // Only a list with a history has a change log: one more read, not one per card.
  const toolRevisions = toolsRevision
    ? await getPublicMcpToolRevisions(decodedIdentifier)
    : null;
  const authExplanation = mcpAuthExplanation(manifest.auth);
  // A stdio package the sandbox could not list tools for says so in place
  // of "0 tools": in the facts, the section nav and the empty tool list.
  const toolsValidation = mcpToolsValidation(item, versions);
  // The verified owner listed the tools from their own session (Issue #367,
  // W7): said beside the list, since the registry/probe did not find them.
  const toolsListedByOwner =
    Boolean(manifest.owner?.fields.includes("tools")) ||
    manifest.tools.some(
      (tool) => tool.source === MARKET_MCP_TOOL_SOURCE_OWNER_SUBMITTED,
    );
  const toolsValidationReason = toolsValidation
    ? tValidation(
        `reason.${mcpToolsValidationReasonKey(toolsValidation.reason)}`,
      )
    : null;
  const categoryNames = mcpCategoryNames(categoriesResponse.items);
  const relatedMarket =
    item.categories.length > 0
      ? await listPublicMcp({
          category: item.categories.join(","),
          includeDesktopOnly: true,
          limit: 12,
          locale: overviewLocale,
        })
      : { items: [] };
  const relatedItems = relatedMcpItems({
    categories: item.categories,
    currentIdentifier: item.identifier,
    items: relatedMarket.items,
    runtime: item.runtime,
    transport: manifest.transport,
  });
  const productGroup = productGroupView(relatedProduct, item.identifier);
  const trusted = Boolean(item.official || item.verified);
  const description = publicMcpDescription({ item, manifest });
  const providerName = item.providerName ?? manifest.providerName;
  const sourceUrl = manifest.sourceUrl ?? item.sourceUrl;
  const repoUrl = manifest.repoUrl ?? item.repoUrl;
  const homepageUrl = manifest.homepageUrl ?? item.homepageUrl;
  // The endpoint's own documentation link, from its protected-resource
  // metadata (W1); the facts panel shows it, and it is one of the server's
  // addresses. Never fetched.
  const documentationUrl = mcpDocumentationUrl(version.provenanceJson);
  const clientConfig = remoteMcpClientConfig(manifest);
  // The hero already shows the summary; only a longer description adds
  // anything. An AI overview, when there is one, takes the description's
  // place; the description itself is never changed. Without an overview the
  // section holds the facts panel (#367 W4), so it is always there.
  const overviewText =
    !aiOverview && manifest.description && manifest.description !== item.summary
      ? manifest.description
      : null;
  const shownReadme = hasMcpReadmeToShow(readme) ? readme : null;
  const primaryCategory = item.categories[0];
  const installHref = authState.isSignedIn
    ? `/dashboard/mcp?mcp=${encodeURIComponent(item.identifier)}`
    : "/auth/sign-in";
  const sectionLinks = [
    ["overview", t("nav.overview")],
    ["installation", t("nav.installation")],
    ...(shownReadme ? [["readme", t("nav.readme")]] : []),
    [
      "tools",
      toolsValidation
        ? t("nav.toolsNotValidated")
        : t("nav.tools", { count: manifest.tools.length }),
    ],
    ...(versions.length > 0
      ? [["versions", t("nav.versions", { count: versions.length })]]
      : []),
    ...(score ? [["score", tScore("nav")]] : []),
    ...(productGroup && productGroup.others.length > 0
      ? [
          [
            "integrations",
            t("nav.integrations", {
              brand: productGroup.brand,
              count: productGroup.others.length,
            }),
          ],
        ]
      : []),
    ...(relatedItems.length > 0 ? [["related", t("nav.related")]] : []),
  ];
  const softwareJsonLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    applicationCategory: "DeveloperApplication",
    description,
    // The tools are the application's features; schema.org has no list of
    // them other than this, and an ItemList would need a page per tool.
    ...(manifest.tools.length > 0
      ? {
          featureList: manifest.tools
            .slice(0, MAX_JSON_LD_FEATURES)
            .map((tool) => tool.name),
        }
      : {}),
    isAccessibleForFree: true,
    name: `${item.name} MCP Server`,
    offers: {
      "@type": "Offer",
      price: 0,
      priceCurrency: "USD",
    },
    operatingSystem:
      item.runtime === "desktop" ? "Windows, macOS, Linux" : "Web",
    provider: {
      "@type": "Organization",
      name: providerName ?? "SourceWeft MCP Market",
    },
    sameAs: [homepageUrl, repoUrl, sourceUrl, documentationUrl].filter(Boolean),
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
        name: t("breadcrumbHome"),
        position: 1,
      },
      {
        "@type": "ListItem",
        item: `${SITE_URL}/mcp`,
        name: t("breadcrumbServers"),
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
      <SourceWeftHeader authState={authState} />

      <div className={`mx-auto pb-10 pt-24 ${marketingContainerClassName}`}>
        <nav
          aria-label={t("breadcrumb")}
          className="mb-8 flex min-w-0 items-center gap-1.5 text-sm text-zinc-500 dark:text-zinc-400"
        >
          <LocaleLink
            className="shrink-0 hover:text-zinc-950 dark:hover:text-white"
            href="/mcp"
          >
            {t("breadcrumbServers")}
          </LocaleLink>
          {primaryCategory ? (
            <>
              <ChevronRight className="size-3.5 shrink-0" />
              <LocaleLink
                className="shrink-0 hover:text-zinc-950 dark:hover:text-white"
                href={`/mcp?category=${encodeURIComponent(primaryCategory)}`}
              >
                {mcpCategoryLabel(primaryCategory, categoryNames)}
              </LocaleLink>
            </>
          ) : null}
          <ChevronRight className="size-3.5 shrink-0" />
          <span className="truncate text-zinc-950 dark:text-white">
            {item.identifier}
          </span>
        </nav>

        {/*
            The same shell as the skill page: one grid for head and body, the
            first row sized by the title alone, the facts card spanning two
            rows so its height flows into the content row, and the details
            rail following it. Below `lg` the cells stack in DOM order.
          */}
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px] lg:grid-rows-[max-content_1fr] lg:items-start">
          <div className="order-1 min-w-0 lg:order-none lg:col-start-1 lg:row-start-1">
            <div className="flex items-start gap-4">
              <McpIcon
                iconSource={item.iconSource}
                iconUrl={item.iconUrl}
                name={item.name}
                size="lg"
                trusted={trusted}
              />
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
                  {item.publisher ? (
                    <span data-publisher-domain={item.publisher.domain}>
                      {t("publishedBy", { domain: item.publisher.domain })}
                    </span>
                  ) : null}
                  <span>v{version.version}</span>
                  <span>
                    {t("updated", { date: formatDate(item.updatedAt) })}
                  </span>
                </p>
              </div>
            </div>
            <p className="mt-6 max-w-3xl text-lg leading-8 text-zinc-600 dark:text-zinc-300">
              {item.summary || description}
            </p>
            {productGroup?.official ? (
              <p
                className="mt-3 text-sm text-zinc-500 dark:text-zinc-400"
                data-official-pointer={productGroup.official.identifier}
              >
                {t.rich("officialPointer", {
                  name: productGroup.official.name,
                  link: (chunks) => (
                    <LocaleLink
                      className="font-medium text-zinc-950 underline underline-offset-4 dark:text-white"
                      href={mcpPath(productGroup.official!.identifier)}
                    >
                      {chunks}
                    </LocaleLink>
                  ),
                })}
              </p>
            ) : null}
            <div className="mt-6 flex flex-wrap gap-2">
              <McpVerificationBadge item={item} />
              {item.claimed ? <McpClaimedBadge /> : null}
              {item.deprecated ? <McpDeprecatedBadge /> : null}
              <McpTransportBadge transport={manifest.transport} />
              <McpRuntimeBadge item={item} />
              {item.categories.map((category) => (
                <LocaleLink
                  className="inline-flex h-6 items-center rounded-full border border-zinc-300 bg-white/70 px-2.5 text-xs font-medium text-zinc-600 transition-colors hover:border-zinc-950 hover:text-zinc-950 dark:border-white/10 dark:bg-white/[0.04] dark:text-zinc-300 dark:hover:border-white/40 dark:hover:text-white"
                  href={`/mcp?category=${encodeURIComponent(category)}`}
                  key={category}
                >
                  {mcpCategoryLabel(category, categoryNames)}
                </LocaleLink>
              ))}
            </div>
          </div>

          {/* One right-column element from `lg` up; see the skill page. */}
          <div className="contents lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:block lg:space-y-8 lg:self-stretch">
            <aside className="order-2 rounded-xl border border-zinc-300 bg-white/70 p-5 lg:order-none dark:border-white/10 dark:bg-white/[0.04]">
              <dl className="grid grid-cols-2 gap-4 text-sm">
                {[
                  toolsValidationReason
                    ? {
                        label: t("tools"),
                        value: tValidation("notValidated"),
                        explanation: tValidation("explain", {
                          reason: toolsValidationReason,
                        }),
                      }
                    : {
                        label: t("tools"),
                        value: String(manifest.tools.length),
                      },
                  {
                    label: t("auth"),
                    value: tAuth(mcpAuthMethod(manifest.auth)),
                    // A second <dd>: the value stays its own term's first
                    // description, wrapping rather than truncating.
                    explanation: tAuth(
                      `explain.${authExplanation.key}`,
                      authExplanation.values,
                    ),
                  },
                  {
                    label: t("license"),
                    value: manifest.license ?? item.license ?? t("unknown"),
                  },
                  {
                    label: t("language"),
                    value: manifest.language ?? item.language ?? t("unknown"),
                  },
                ].map(({ label, value, explanation }) => (
                  <div className="min-w-0" key={label}>
                    <dt className="text-xs text-zinc-500">{label}</dt>
                    <dd
                      className={
                        explanation
                          ? "mt-1 break-words font-medium"
                          : "mt-1 truncate font-medium"
                      }
                    >
                      {value}
                    </dd>
                    {explanation ? (
                      <dd className="mt-1 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
                        {explanation}
                      </dd>
                    ) : null}
                  </div>
                ))}
              </dl>
              <LocaleLink
                className="mt-5 inline-flex h-10 w-full items-center justify-center rounded-lg bg-zinc-950 px-4 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-100"
                href={installHref}
              >
                {authState.isSignedIn
                  ? t("addToWorkspace")
                  : t("signInToInstall")}
              </LocaleLink>
              <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2">
                <ExternalTextLink href={homepageUrl}>
                  {t("homepage")}
                </ExternalTextLink>
                <ExternalTextLink href={manifest.documentationUrl}>
                  {t("documentation")}
                </ExternalTextLink>
                <ExternalTextLink href={repoUrl}>
                  {t("repository")}
                </ExternalTextLink>
                <ExternalTextLink href={sourceUrl}>
                  {t("source")}
                </ExternalTextLink>
              </div>
              {/* The publisher's way in (Issue #367, W7); members only, as
                  the claim page needs a session anyway. */}
              {authState.isSignedIn ? (
                <p className="mt-4 border-t border-zinc-200 pt-3 text-xs dark:border-white/10">
                  <LocaleLink
                    className="text-zinc-500 underline decoration-zinc-300 underline-offset-4 hover:text-zinc-950 hover:decoration-zinc-950 dark:decoration-white/20 dark:hover:text-white"
                    data-testid="mcp-claim-link"
                    href={mcpClaimHref(item.identifier)}
                    prefetch={false}
                    rel="nofollow"
                  >
                    {item.claimed ? t("manageListingLink") : t("claimLink")}
                  </LocaleLink>
                </p>
              ) : null}
            </aside>

            <aside className="order-4 space-y-5 lg:order-none lg:sticky lg:top-20">
              <section className={panelClassName}>
                <h2 className="mb-4 text-base font-semibold">
                  {t("serverDetails")}
                </h2>
                <dl className="space-y-3 text-sm">
                  {[
                    [t("identifier"), item.identifier],
                    [t("transport"), transportLabel(manifest.transport)],
                    [t("runtime"), runtimeLabel(item)],
                    [t("trust"), verificationLabel(item)],
                    [
                      t("published"),
                      formatDate(item.publishedAt ?? item.createdAt),
                    ],
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
                  {t("securityHeading")}
                </div>
                <p>{t("securityBody")}</p>
              </section>

              <section className={panelClassName}>
                <CatalogBadgeSnippet
                  display="disclosure"
                  siteUrl={SITE_URL}
                  surface="mcp_detail"
                  target={{ kind: "mcp", key: item.identifier }}
                />
              </section>
            </aside>
          </div>

          <div className="order-3 min-w-0 lg:order-none lg:col-start-1 lg:row-start-2">
            <nav
              aria-label={t("sections")}
              className="sticky top-14 z-40 border-b border-zinc-300 bg-[#f7f4ed]/90 backdrop-blur-[12px] dark:border-white/10 dark:bg-zinc-950/90"
            >
              <div className="flex gap-6 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
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

            <div className="min-w-0 space-y-12 pt-8">
              <section className="scroll-mt-32" id="overview">
                <SectionHeading icon={McpBrandIcon}>
                  {t("overviewHeading")}
                </SectionHeading>
                {aiOverview ? (
                  <McpAiOverviewView
                    className="last:mb-0"
                    overview={aiOverview}
                    requestedLocale={overviewLocale}
                  />
                ) : (
                  <McpFactsPanel
                    className={`${panelClassName} mb-4 last:mb-0`}
                    facts={publicMcpFacts({
                      item,
                      manifest,
                      provenanceJson: version.provenanceJson,
                    })}
                  />
                )}
                {overviewText || manifest.riskSummary ? (
                  <div
                    className={`${panelClassName} space-y-4 divide-y divide-zinc-200 dark:divide-white/10 [&>*:not(:first-child)]:pt-4`}
                  >
                    {overviewText ? (
                      <p className="whitespace-pre-line text-sm leading-7 text-zinc-600 dark:text-zinc-300">
                        {overviewText}
                      </p>
                    ) : null}
                    {manifest.riskSummary ? (
                      <p className="text-sm leading-6 text-zinc-600 dark:text-zinc-400">
                        <span className="font-medium text-zinc-950 dark:text-white">
                          {t("riskSummary")}
                        </span>
                        {manifest.riskSummary}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </section>

              <section className="scroll-mt-32" id="installation">
                <SectionHeading icon={KeyRound}>
                  {t("installationHeading")}
                </SectionHeading>
                <div className="space-y-4">
                  <div className={panelClassName}>
                    <h3 className="font-semibold">{t("inSourceWeft")}</h3>
                    <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
                      <li>
                        {t.rich("step1", {
                          name: item.name,
                          link: (chunks) => (
                            <LocaleLink
                              className="font-medium text-zinc-950 underline underline-offset-4 dark:text-white"
                              href={installHref}
                            >
                              {chunks}
                            </LocaleLink>
                          ),
                        })}
                      </li>
                      {manifest.auth.required ? (
                        <li>
                          {t("step2", {
                            name:
                              manifest.auth.displayName ?? t("step2Fallback"),
                          })}
                        </li>
                      ) : null}
                      <li>{t("step3")}</li>
                    </ol>
                    <p className="mt-4 rounded-lg bg-zinc-100 p-3 text-xs leading-5 text-zinc-600 dark:bg-white/[0.04] dark:text-zinc-400">
                      {t("runtimeVia", {
                        runtime: runtimeLabel(item),
                        transport: transportLabel(manifest.transport),
                      })}
                      {manifest.transport === "stdio"
                        ? t("stdioNote")
                        : t("remoteNote")}
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
                          <h3 className="font-semibold">{t("otherClients")}</h3>
                          <p className="mt-1 text-xs text-zinc-500">
                            {t.rich("otherClientsConfig", {
                              code: (chunks) => <code>{chunks}</code>,
                            })}
                            {manifest.auth.type === "oauth"
                              ? t("oauthNote")
                              : ""}
                          </p>
                        </div>
                        <CopyButton
                          copiedLabel={t("copied")}
                          failedLabel={t("copyFailed")}
                          label={t("copy")}
                          value={clientConfig}
                        />
                      </div>
                      <pre className="mt-4 overflow-x-auto rounded-lg bg-zinc-950 p-4 font-mono text-xs leading-5 text-zinc-100">
                        {clientConfig}
                      </pre>
                    </div>
                  ) : repoUrl ? (
                    <div
                      className={`${panelClassName} text-sm text-zinc-600 dark:text-zinc-400`}
                    >
                      <h3 className="font-semibold text-zinc-950 dark:text-white">
                        {t("otherClients")}
                      </h3>
                      <p className="mt-2">
                        {t.rich("followRepo", {
                          link: (chunks) => (
                            <ExternalTextLink href={repoUrl}>
                              {chunks}
                            </ExternalTextLink>
                          ),
                        })}
                      </p>
                    </div>
                  ) : null}
                </div>
              </section>

              {shownReadme ? (
                <section className="scroll-mt-32" id="readme">
                  <SectionHeading icon={FileText}>
                    {t("readmeHeading")}
                  </SectionHeading>
                  <div className={`${panelClassName} space-y-4`}>
                    <McpReadmeCollapse
                      collapsible={isLongMcpReadme(shownReadme.markdown)}
                    >
                      <McpReadmeSection {...shownReadme} />
                    </McpReadmeCollapse>
                    <McpReadmeSourceLine readme={shownReadme} />
                    <McpReadmeRepositoryLink readme={shownReadme} />
                  </div>
                </section>
              ) : null}

              <section className="scroll-mt-32" id="tools">
                <SectionHeading count={manifest.tools.length} icon={Code2}>
                  {t("toolsHeading")}
                </SectionHeading>
                {toolsListedByOwner ? (
                  <p
                    className="mb-3 text-sm text-zinc-600 dark:text-zinc-400"
                    data-testid="mcp-tools-listed-by-owner"
                  >
                    <span className="font-semibold text-zinc-900 dark:text-zinc-100">
                      {t("toolsListedByOwner")}
                    </span>{" "}
                    {t("toolsListedByOwnerHint")}
                  </p>
                ) : null}
                <McpToolRows
                  tools={manifest.tools}
                  validation={toolsValidation}
                />
                {toolRevisions ? (
                  <McpToolChangeLog history={toolRevisions} />
                ) : null}
              </section>

              {versions.length > 0 ? (
                <section className="scroll-mt-32" id="versions">
                  <SectionHeading count={versions.length} icon={History}>
                    {t("versionsHeading")}
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
                              {t("latest")}
                            </span>
                          ) : null}
                        </span>
                        <span className="text-zinc-500">
                          {entry.publishedAt
                            ? formatDate(entry.publishedAt)
                            : entry.status}
                        </span>
                      </li>
                    ))}
                  </ol>
                </section>
              ) : null}

              {score ? (
                <section className="scroll-mt-32" id="score">
                  <SectionHeading icon={Gauge}>
                    {tScore("heading")}
                  </SectionHeading>
                  <McpScoreCard score={score} />
                </section>
              ) : null}

              {productGroup && productGroup.others.length > 0 ? (
                <section className="scroll-mt-32" id="integrations">
                  <SectionHeading
                    count={productGroup.others.length}
                    icon={Layers}
                  >
                    {t("integrationsHeading", { brand: productGroup.brand })}
                  </SectionHeading>
                  <McpCardGrid
                    categoryNames={categoryNames}
                    className="md:grid-cols-2 xl:grid-cols-2"
                    items={productGroup.others}
                  />
                </section>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      {relatedItems.length > 0 ? (
        <section
          className={`mx-auto scroll-mt-32 pb-16 ${marketingContainerClassName}`}
          id="related"
        >
          <div className="border-t border-zinc-300 pt-10 dark:border-white/10">
            <h2 className="mb-6 text-2xl font-semibold tracking-tight">
              {t("relatedHeading", { name: item.name })}
            </h2>
            <McpCardGrid categoryNames={categoryNames} items={relatedItems} />
          </div>
        </section>
      ) : null}

      <SourceWeftFooter authState={authState} />
    </main>
  );
}
