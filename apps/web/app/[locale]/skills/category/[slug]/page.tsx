import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { routing } from "../../../../../i18n/routing";
import { JsonLd } from "../../../../_components/seo/json-ld";
import { SkillIcon } from "../../../../_components/site-icons";
import { resolveInitialLandingAuthState } from "../../../../_landing/auth-state-server";
import { SourceWeftFooter } from "../../../../_landing/components/sourceweft-footer";
import { SourceWeftHeader } from "../../../../_landing/components/sourceweft-header";
import {
  isIndexableListing,
  NO_INDEX_METADATA,
  OG_IMAGE,
  SITE_NAME,
  SITE_URL,
} from "../../../../seo";
import {
  listPublicSkills,
  marketSkillLocale,
  requirePublicSkillCategories,
} from "../../../../../lib/market-skills";
import {
  isSkillsNarrowed,
  parseSkillsBrowseState,
  skillsListRequest,
  type SkillsSearchParams,
} from "../../_components/skills-browse";
import {
  skillCategoryPath,
  skillPath,
  skillsContainerClassName,
} from "../../_components/skills-format";
import {
  SkillsListingView,
  SkillsSearchForm,
} from "../../_components/skills-listing";

// Canonical and JSON-LD embed the public site URL, which is injected at
// container start, so this must never be prerendered at build time. Freshness
// comes from the cached market reads (300s).
export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ locale: string; slug: string }>;
  searchParams: Promise<SkillsSearchParams>;
};

async function loadCategories() {
  // Throws on a market outage so the page 5xxs rather than 404ing every
  // category at once.
  return requirePublicSkillCategories();
}

export async function generateMetadata({
  params,
  searchParams,
}: PageProps): Promise<Metadata> {
  const { locale, slug } = await params;
  if (!hasLocale(routing.locales, locale)) {
    return {};
  }
  const t = await getTranslations({
    locale,
    namespace: "publicSkills.category",
  });
  const decodedSlug = decodeURIComponent(slug);
  const { items } = await loadCategories();
  const category = items.find((entry) => entry.slug === decodedSlug);

  if (!category) {
    return {
      ...NO_INDEX_METADATA,
      title: t("fallbackMetaTitle"),
    };
  }

  const state = parseSkillsBrowseState(await searchParams, {
    category: category.slug,
  });
  const title = t("title", { name: category.name });
  const description =
    category.description ?? t("metaDescription", { name: category.name });
  const url = `${SITE_URL}${skillCategoryPath(category.slug)}`;

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
    // A search, facet, sort or page inside the category is one of infinitely
    // many views of the same page, so only the bare category URL is offered for
    // indexing — and only when it is not thin.
    ...(!isSkillsNarrowed(state) && isIndexableListing(category.count)
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

export default async function PublicSkillCategoryPage({
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
  const t = await getTranslations("publicSkills");
  const decodedSlug = decodeURIComponent(slug);
  const [authState, categoriesResponse] = await Promise.all([
    resolveInitialLandingAuthState(),
    loadCategories(),
  ]);
  const category = categoriesResponse.items.find(
    (entry) => entry.slug === decodedSlug,
  );

  if (!category) {
    notFound();
  }

  const state = parseSkillsBrowseState(rawSearchParams, {
    category: category.slug,
  });
  const market = await listPublicSkills({
    ...skillsListRequest(state),
    // The language of each card's AI summary.
    locale: marketSkillLocale(locale),
  });
  const title = t("category.title", { name: category.name });
  const description =
    category.description ?? t("category.description", { name: category.name });
  const breadcrumbJsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      {
        "@type": "ListItem",
        item: SITE_URL,
        name: t("breadcrumb.home"),
        position: 1,
      },
      {
        "@type": "ListItem",
        item: `${SITE_URL}/skills`,
        name: t("breadcrumb.skills"),
        position: 2,
      },
      {
        "@type": "ListItem",
        item: `${SITE_URL}${skillCategoryPath(category.slug)}`,
        name: title,
        position: 3,
      },
    ],
  };
  const itemListJsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: market.items.map((skill, index) => ({
      "@type": "ListItem",
      name: skill.displayName,
      position: index + 1,
      url: `${SITE_URL}${skillPath(skill.slug)}`,
    })),
  };

  return (
    <main className="min-h-svh bg-[#f7f4ed] text-zinc-950 dark:bg-zinc-950 dark:text-white">
      <JsonLd data={breadcrumbJsonLd} />
      <JsonLd data={itemListJsonLd} />
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
          className={`relative mx-auto pb-8 pt-24 ${skillsContainerClassName}`}
        >
          <Link
            className="mb-8 inline-flex items-center gap-2 text-sm text-zinc-500 transition-colors hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-white"
            href="/skills"
          >
            <ArrowLeft className="size-4" />
            {t("category.back")}
          </Link>
          <div className="max-w-4xl">
            <span className="mb-5 inline-flex items-center gap-2 rounded-full border border-zinc-300 bg-white/48 px-3 py-1 text-xs font-medium text-zinc-600 dark:border-white/10 dark:bg-white/[0.04] dark:text-zinc-400">
              <SkillIcon className="size-3.5" />
              {category.name}
            </span>
            <h1 className="text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
              {title}
            </h1>
            <p className="mt-4 max-w-2xl text-base leading-7 text-zinc-600 dark:text-zinc-300">
              {description}
            </p>
          </div>

          <SkillsSearchForm
            action={skillCategoryPath(category.slug)}
            className="mt-6"
            state={state}
          />
        </div>
      </section>

      <SkillsListingView
        categories={categoriesResponse.items}
        market={market}
        state={state}
        title={
          state.query
            ? t("listing.resultsForIn", {
                category: category.name,
                query: state.query,
              })
            : undefined
        }
        total={categoriesResponse.total}
      />

      <SourceWeftFooter
        authState={authState}
        containerClassName={skillsContainerClassName}
      />
    </main>
  );
}
