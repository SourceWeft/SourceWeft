import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { JsonLd } from "../../../_components/seo/json-ld";
import { SkillIcon } from "../../../_components/site-icons";
import { resolveInitialLandingAuthState } from "../../../_landing/auth-state-server";
import { SourceWeftFooter } from "../../../_landing/components/sourceweft-footer";
import { SourceWeftHeader } from "../../../_landing/components/sourceweft-header";
import {
  isIndexableListing,
  NO_INDEX_METADATA,
  OG_IMAGE,
  SITE_NAME,
  SITE_URL,
} from "../../../seo";
import {
  listPublicSkills,
  requirePublicSkillCategories,
} from "../../../../lib/market-skills";
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
import { skillsCopy } from "../../_components/skills-public-copy";

// Canonical and JSON-LD embed the public site URL, which is injected at
// container start, so this must never be prerendered at build time. Freshness
// comes from the cached market reads (300s).
export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ slug: string }>;
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
  const { slug } = await params;
  const decodedSlug = decodeURIComponent(slug);
  const { items } = await loadCategories();
  const category = items.find((entry) => entry.slug === decodedSlug);

  if (!category) {
    return { ...NO_INDEX_METADATA, title: skillsCopy.category.fallbackMetaTitle };
  }

  const state = parseSkillsBrowseState(await searchParams, {
    category: category.slug,
  });
  const title = skillsCopy.category.title(category.name);
  const description =
    category.description ?? skillsCopy.category.metaDescription(category.name);
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
  const [{ slug }, rawSearchParams] = await Promise.all([params, searchParams]);
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
  const market = await listPublicSkills(skillsListRequest(state));
  const title = skillsCopy.category.title(category.name);
  const description =
    category.description ?? skillsCopy.category.description(category.name);
  const breadcrumbJsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      {
        "@type": "ListItem",
        item: SITE_URL,
        name: skillsCopy.breadcrumb.home,
        position: 1,
      },
      {
        "@type": "ListItem",
        item: `${SITE_URL}/skills`,
        name: skillsCopy.breadcrumb.skills,
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
        <div className={`relative mx-auto pb-8 pt-24 ${skillsContainerClassName}`}>
          <Link
            className="mb-8 inline-flex items-center gap-2 text-sm text-zinc-500 transition-colors hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-white"
            href="/skills"
          >
            <ArrowLeft className="size-4" />
            {skillsCopy.category.back}
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
            ? skillsCopy.listing.resultsForIn(state.query, category.name)
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
