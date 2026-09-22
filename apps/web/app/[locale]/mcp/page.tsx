import { McpIcon as McpBrandIcon } from "../../_components/site-icons";
import type { Metadata } from "next";
import { LocaleLink } from "../_components/locale-link";
import { ArrowRight, Upload, Wrench } from "lucide-react";
import type { MarketCategory, MarketItemSummary } from "@sourceweft/market-sdk";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { formatNumber } from "@sourceweft/i18n/format";
import { DEFAULT_LOCALE, isLocale } from "@sourceweft/i18n/locales";

import { cn } from "@sourceweft/ui-web/lib/utils";
import { routing } from "../../../i18n/routing";
import { buildAlternates } from "../../../lib/i18n/metadata";

import { resolveInitialLandingAuthState } from "../../_landing/auth-state-server";
import { SourceWeftFooter } from "../../_landing/components/sourceweft-footer";
import { SourceWeftHeader } from "../../_landing/components/sourceweft-header";
import { JsonLd } from "../../_components/seo/json-ld";
import { NO_INDEX_METADATA, OG_IMAGE, SITE_NAME, SITE_URL } from "../../seo";
import {
  countPublicMcpByCategory,
  listPublicMcp,
  listPublicMcpCategories,
} from "../../../lib/market-mcp";
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
  mcpFaqKeys,
  McpFaqSection,
  mcpPath,
} from "./_components/mcp-display";

export const revalidate = 300;

const HOME_SECTION_SIZE = 6;
const HOME_CATEGORY_SECTIONS = 4;


type PageProps = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<McpSearchParams>;
};

export async function generateMetadata({
  params,
  searchParams,
}: PageProps): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) {
    return {};
  }
  const state = parseMcpBrowseState(await searchParams);
  const listView = isMcpListView(state);
  const t = await getTranslations({ locale, namespace: "mcp.meta" });

  return {
    // The directory shell is localized → hreflang across locales; search/facet
    // permutations stay noindex with a plain canonical (§20).
    alternates: listView
      ? { canonical: `${SITE_URL}/mcp` }
      : buildAlternates("/mcp", locale),
    description: t("description"),
    openGraph: {
      description: t("socialDescription"),
      images: [OG_IMAGE],
      siteName: SITE_NAME,
      title: t("title"),
      type: "website",
      url: `${SITE_URL}/mcp`,
    },
    // Search, facet, and paged permutations are infinite and add nothing over
    // the directory itself, so they stay crawlable but out of the index.
    ...(listView ? NO_INDEX_METADATA : {}),
    title: t("title"),
    twitter: {
      card: "summary_large_image",
      description: t("socialDescription"),
      images: [OG_IMAGE.url],
      title: t("title"),
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

async function GetStartedPanels({ signedIn }: { signedIn: boolean }) {
  const t = await getTranslations("mcp.getStarted");
  const dashboardHref = signedIn ? "/dashboard/mcp" : "/auth/sign-in";
  const panels = (["install", "publish"] as const).map((key) => ({
    cta: signedIn ? t(`${key}.ctaSignedIn`) : t(`${key}.ctaSignedOut`),
    description: t(`${key}.description`),
    icon: key === "install" ? Wrench : Upload,
    steps: t.raw(`${key}.steps`) as string[],
    title: t(`${key}.title`),
  }));
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
          <LocaleLink
            className="group mt-5 inline-flex items-center gap-1.5 self-start text-sm font-medium text-zinc-950 dark:text-white"
            href={dashboardHref}
          >
            {panel.cta}
            <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
          </LocaleLink>
        </div>
      ))}
    </div>
  );
}

export default async function PublicMcpMarketPage({
  params: routeParams,
  searchParams,
}: PageProps) {
  const { locale } = await routeParams;
  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }
  setRequestLocale(locale);
  const t = await getTranslations("mcp");
  const uiLocale = isLocale(locale) ? locale : DEFAULT_LOCALE;
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
    mainEntity: mcpFaqKeys.map((key) => ({
      "@type": "Question",
      acceptedAnswer: {
        "@type": "Answer",
        text: t(`faq.items.${key}.answer`),
      },
      name: t(`faq.items.${key}.question`),
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
              <McpBrandIcon className="size-3.5" />
              {t("hero.badge")}
            </span>
            {listView ? (
              <p className="text-3xl font-semibold tracking-tight sm:text-4xl">
                {t("meta.title")}
              </p>
            ) : (
              <>
                <h1 className="text-5xl font-semibold leading-[0.95] tracking-tight sm:text-6xl lg:text-7xl">
                  {t("meta.title")}
                </h1>
                <p className="mt-6 max-w-2xl text-lg leading-8 text-zinc-600 dark:text-zinc-300">
                  {t("hero.subtitle", { count: facets.total })}
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
          title={
            state.query ? t("results", { query: state.query }) : t("allServers")
          }
          total={facets.total}
        />
      ) : null}

      {home ? (
        <div className={cn("mx-auto space-y-14 py-12", mcpContainerClassName)}>
          <McpDirectorySection
            categoryNames={categoryNames}
            description={t("directory.featuredDescription")}
            items={home.featured}
            title={t("directory.featuredTitle")}
            viewAllHref="/mcp?trust=verified"
          />
          <McpDirectorySection
            categoryNames={categoryNames}
            description={t("directory.recentDescription")}
            items={home.recent}
            title={t("directory.recentTitle")}
            viewAllHref="/mcp?view=all"
          />
          {home.categories.map(({ category, items }) => (
            <McpDirectorySection
              categoryNames={categoryNames}
              description={
                category.description ??
                t("directory.categoryPopular", {
                  category: category.name.toLowerCase(),
                })
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
              <McpBrandIcon className="mx-auto mb-4 size-8 text-zinc-400" />
              <h2 className="text-2xl font-semibold tracking-tight">
                {t("listing.syncingTitle")}
              </h2>
              <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-zinc-500 dark:text-zinc-400">
                {t("listing.syncingBody")}
              </p>
            </div>
          ) : null}

          {categories.length > 0 ? (
            <section>
              <h2 className="mb-5 text-2xl font-semibold tracking-tight">
                {t("directory.browseByCategory")}
              </h2>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {categories.map((category) => (
                  <LocaleLink
                    className="group flex items-center justify-between gap-3 rounded-xl border border-zinc-300 bg-white/50 px-4 py-3 text-sm transition-colors hover:border-zinc-950 hover:bg-white dark:border-white/10 dark:bg-white/[0.03] dark:hover:border-white/35"
                    href={mcpCategoryPath(category.slug)}
                    key={category.slug}
                  >
                    <span className="truncate font-medium">{category.name}</span>
                    <span className="text-xs tabular-nums text-zinc-400">
                      {formatNumber(facets.counts[category.slug] ?? 0, uiLocale)}
                    </span>
                  </LocaleLink>
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
