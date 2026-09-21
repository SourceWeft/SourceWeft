import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Upload, Wrench } from "lucide-react";
import type {
  MarketSkillLocale,
  MarketSkillSummary,
} from "@sourceweft/market-sdk";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { formatNumber } from "@sourceweft/i18n/format";
import { DEFAULT_LOCALE, isLocale } from "@sourceweft/i18n/locales";

import { cn } from "@sourceweft/ui-web/lib/utils";
import { routing } from "../../../i18n/routing";
import { buildAlternates } from "../../../lib/i18n/metadata";

import { JsonLd } from "../../_components/seo/json-ld";
import { SkillIcon } from "../../_components/site-icons";
import { resolveInitialLandingAuthState } from "../../_landing/auth-state-server";
import { SourceWeftFooter } from "../../_landing/components/sourceweft-footer";
import { SourceWeftHeader } from "../../_landing/components/sourceweft-header";
import { NO_INDEX_METADATA, OG_IMAGE, SITE_NAME, SITE_URL } from "../../seo";
import {
  listPublicSkillCategories,
  listPublicSkillCollections,
  listPublicSkills,
  marketSkillLocale,
} from "../../../lib/market-skills";
import {
  defaultSkillsBrowseState,
  isSkillsListView,
  parseSkillsBrowseState,
  skillsBrowseHref,
  skillsListRequest,
  type SkillsSearchParams,
} from "./_components/skills-browse";
import {
  skillCategoryNames,
  SkillCollectionsSection,
  SkillDirectorySection,
  skillsFaqKeys,
  SkillsFaqSection,
} from "./_components/skills-display";
import {
  skillCategoryPath,
  skillPath,
  skillsContainerClassName,
} from "./_components/skills-format";
import {
  SkillsListingView,
  SkillsSearchForm,
} from "./_components/skills-listing";

export const revalidate = 60;

const HOME_SECTION_SIZE = 6;

type PageProps = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<SkillsSearchParams>;
};

export async function generateMetadata({
  params,
  searchParams,
}: PageProps): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) {
    return {};
  }
  const state = parseSkillsBrowseState(await searchParams);
  const listView = isSkillsListView(state);
  const t = await getTranslations({
    locale,
    namespace: "publicSkills.landing",
  });
  const title = t("title");
  const description = t("description");
  const socialDescription = t("socialDescription");

  return {
    alternates: {
      // The directory shell is localized → hreflang across locales; search,
      // facet and paged permutations stay noindex with a plain canonical.
      ...(listView
        ? { canonical: `${SITE_URL}/skills` }
        : buildAlternates("/skills", locale)),
      // For agents: how to search and install from this directory with the
      // CLI, as a SKILL.md. The same address for everyone — no UA sniffing.
      types: { "text/markdown": "/skills/SKILL.md" },
    },
    description,
    openGraph: {
      description: socialDescription,
      images: [OG_IMAGE],
      siteName: SITE_NAME,
      title,
      type: "website",
      url: `${SITE_URL}/skills`,
    },
    // Search, facet, sort, and paged permutations are infinite and add nothing
    // over the directory itself, so they stay crawlable but out of the index.
    ...(listView ? NO_INDEX_METADATA : {}),
    title,
    twitter: {
      card: "summary_large_image",
      description: socialDescription,
      images: [OG_IMAGE.url],
      title,
    },
  };
}

function uniqueSkills(skills: MarketSkillSummary[]) {
  const seen = new Set<string>();
  return skills.filter((skill) => {
    if (seen.has(skill.slug)) return false;
    seen.add(skill.slug);
    return true;
  });
}

// `locale` is the language of each card's AI summary.
async function loadHomeSections(locale: MarketSkillLocale) {
  const [recommended, newest, popular, collections] = await Promise.all([
    listPublicSkills({ limit: HOME_SECTION_SIZE, sort: "recommended", locale }),
    listPublicSkills({ limit: HOME_SECTION_SIZE, sort: "new", locale }),
    listPublicSkills({ limit: HOME_SECTION_SIZE, sort: "popular", locale }),
    listPublicSkillCollections(),
  ]);
  return {
    collections: collections.items,
    newest: newest.items,
    // With no installs anywhere yet, "most installed" is just an arbitrary
    // order, so the section waits for real numbers.
    popular: popular.items.filter((skill) => skill.installCount > 0),
    recommended: recommended.items,
  };
}

async function GetStartedPanels({ signedIn }: { signedIn: boolean }) {
  const t = await getTranslations("publicSkills.landing.getStarted");
  const dashboardHref = signedIn
    ? "/dashboard/skills"
    : `/auth/sign-in?redirectTo=${encodeURIComponent("/dashboard/skills")}`;
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

export default async function PublicSkillsMarketPage({
  params: routeParams,
  searchParams,
}: PageProps) {
  const { locale } = await routeParams;
  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }
  setRequestLocale(locale);
  const t = await getTranslations("publicSkills");
  const uiLocale = isLocale(locale) ? locale : DEFAULT_LOCALE;
  const params = await searchParams;
  const state = parseSkillsBrowseState(params);
  const listView = isSkillsListView(state);

  const [authState, categoriesResponse, market, home] = await Promise.all([
    resolveInitialLandingAuthState(),
    listPublicSkillCategories(),
    listView
      ? listPublicSkills({
          ...skillsListRequest(state),
          locale: marketSkillLocale(uiLocale),
        })
      : null,
    listView ? null : loadHomeSections(marketSkillLocale(uiLocale)),
  ]);
  const categories = categoriesResponse.items;
  const total = categoriesResponse.total;
  const categoryNames = skillCategoryNames(categories);
  const directoryCategories = categories.filter(
    (category) => category.count > 0,
  );

  const pageSkills = market?.items ?? [
    ...(home?.recommended ?? []),
    ...(home?.newest ?? []),
    ...(home?.popular ?? []),
  ];
  const itemListJsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: uniqueSkills(pageSkills).map((skill, index) => ({
      "@type": "ListItem",
      name: skill.displayName,
      position: index + 1,
      url: `${SITE_URL}${skillPath(skill.slug)}`,
    })),
  };
  const faqJsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: skillsFaqKeys.map((key) => ({
      "@type": "Question",
      acceptedAnswer: {
        "@type": "Answer",
        text: t(`faq.items.${key}.answer`),
      },
      name: t(`faq.items.${key}.question`),
    })),
  };
  const homeIsEmpty =
    home !== null &&
    home.recommended.length === 0 &&
    home.newest.length === 0 &&
    home.popular.length === 0;

  return (
    <main className="min-h-svh bg-[#f7f4ed] text-zinc-950 dark:bg-zinc-950 dark:text-white">
      <JsonLd data={itemListJsonLd} />
      {listView ? null : <JsonLd data={faqJsonLd} />}
      <SourceWeftHeader
        authState={authState}
        containerClassName={skillsContainerClassName}
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
            skillsContainerClassName,
          )}
        >
          <div className="max-w-4xl">
            <span className="mb-5 inline-flex items-center gap-2 rounded-full border border-zinc-300 bg-white/48 px-3 py-1 text-xs font-medium text-zinc-600 dark:border-white/10 dark:bg-white/[0.04] dark:text-zinc-400">
              <SkillIcon className="size-3.5" />
              {t("brand")}
            </span>
            {listView ? (
              <p className="text-3xl font-semibold tracking-tight sm:text-4xl">
                {t("landing.title")}
              </p>
            ) : (
              <>
                <h1 className="text-5xl font-semibold leading-[0.95] tracking-tight sm:text-6xl lg:text-7xl">
                  {t("landing.title")}
                </h1>
                <p className="mt-6 max-w-2xl text-lg leading-8 text-zinc-600 dark:text-zinc-300">
                  {total > 0
                    ? t("landing.heroWithCount", { count: total })
                    : t("landing.heroWithoutCount")}{" "}
                  {t("landing.heroTail")}
                </p>
              </>
            )}
          </div>

          <SkillsSearchForm
            action="/skills"
            className={listView ? "mt-6" : "mt-9"}
            state={state}
          />

          {listView ? null : (
            <GetStartedPanels signedIn={authState.isSignedIn} />
          )}
        </div>
      </section>

      {market ? (
        <SkillsListingView
          categories={categories}
          market={market}
          state={state}
          title={
            state.query
              ? t("listing.resultsFor", { query: state.query })
              : t("listing.allSkillsTitle")
          }
          total={total}
        />
      ) : null}

      {home ? (
        <div
          className={cn("mx-auto space-y-14 py-12", skillsContainerClassName)}
        >
          {directoryCategories.length > 0 ? (
            <section>
              <h2 className="mb-5 text-2xl font-semibold tracking-tight">
                {t("landing.browseByCategory")}
              </h2>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {directoryCategories.map((category) => (
                  <Link
                    className="group flex items-center justify-between gap-3 rounded-xl border border-zinc-300 bg-white/50 px-4 py-3 text-sm transition-colors hover:border-zinc-950 hover:bg-white dark:border-white/10 dark:bg-white/[0.03] dark:hover:border-white/35"
                    href={skillCategoryPath(category.slug)}
                    key={category.slug}
                  >
                    <span className="truncate font-medium">
                      {category.name}
                    </span>
                    <span className="text-xs tabular-nums text-zinc-400">
                      {formatNumber(category.count, uiLocale)}
                    </span>
                  </Link>
                ))}
              </div>
            </section>
          ) : null}

          <SkillCollectionsSection collections={home.collections} />

          <SkillDirectorySection
            categoryNames={categoryNames}
            description={t("landing.sections.recommended.description")}
            skills={home.recommended}
            title={t("landing.sections.recommended.title")}
            viewAllHref={skillsBrowseHref(defaultSkillsBrowseState, {
              view: true,
            })}
          />
          <SkillDirectorySection
            categoryNames={categoryNames}
            description={t("landing.sections.newest.description")}
            skills={home.newest}
            title={t("landing.sections.newest.title")}
            viewAllHref={skillsBrowseHref(defaultSkillsBrowseState, {
              sort: "new",
            })}
          />
          <SkillDirectorySection
            categoryNames={categoryNames}
            description={t("landing.sections.popular.description")}
            skills={home.popular}
            title={t("landing.sections.popular.title")}
            viewAllHref={skillsBrowseHref(defaultSkillsBrowseState, {
              sort: "popular",
            })}
          />

          {homeIsEmpty ? (
            <div className="rounded-xl border border-zinc-300 bg-white/54 p-10 text-center dark:border-white/10 dark:bg-white/[0.03]">
              <SkillIcon className="mx-auto mb-4 size-8 text-zinc-400" />
              <h2 className="text-2xl font-semibold tracking-tight">
                {t("landing.emptyTitle")}
              </h2>
              <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-zinc-500 dark:text-zinc-400">
                {t("landing.emptyBody")}
              </p>
            </div>
          ) : null}
        </div>
      ) : null}

      {listView ? null : <SkillsFaqSection />}

      <SourceWeftFooter
        authState={authState}
        containerClassName={skillsContainerClassName}
      />
    </main>
  );
}
