import type { Metadata } from "next";
import { LocaleLink } from "../../../_components/locale-link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { routing } from "../../../../../i18n/routing";
import { buildAlternates } from "../../../../../lib/i18n/metadata";
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
  getPublicSkillCollection,
  marketSkillLocale,
  isMarketNotFound,
  listPublicSkillCategories,
} from "../../../../../lib/market-skills";
import {
  SkillCardGrid,
  skillCategoryNames,
} from "../../_components/skills-display";
import {
  shortSeoText,
  skillCollectionPath,
  skillPath,
  skillsContainerClassName,
} from "../../_components/skills-format";

// Canonical and JSON-LD embed the public site URL, injected at container
// start, so this is never prerendered at build time. Freshness comes from the
// cached market reads (60s).
export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ locale: string; slug: string }>;
};

async function loadCollection(slug: string, locale?: string) {
  try {
    // The locale picks the language of each card's AI summary.
    return await getPublicSkillCollection(
      slug,
      locale ? marketSkillLocale(locale) : undefined,
    );
  } catch (error) {
    // Unpublished or never there: one 404. An outage must stay a 5xx, or it
    // would deindex the page.
    if (isMarketNotFound(error)) {
      notFound();
    }
    throw error;
  }
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { locale, slug } = await params;
  if (!hasLocale(routing.locales, locale)) {
    return {};
  }
  const t = await getTranslations({
    locale,
    namespace: "publicSkills.collections",
  });
  try {
    const { collection } = await loadCollection(decodeURIComponent(slug));
    const title = t("metaTitle", { title: collection.title });
    const description = shortSeoText(
      collection.summary
        ? t("metaDescription", {
            summary: collection.summary,
            title: collection.title,
          })
        : t("metaDescriptionNoSummary", { title: collection.title }),
    );
    const url = `${SITE_URL}${skillCollectionPath(collection.slug)}`;
    return {
      // The shell is localized, so the indexable page carries hreflang and a
    // self-canonical per locale; narrowed views keep the plain canonical.
    alternates: isIndexableListing(collection.itemCount)
      ? buildAlternates(skillCollectionPath(collection.slug), locale)
      : { canonical: url },
      description,
      openGraph: {
        description,
        images: [OG_IMAGE],
        siteName: SITE_NAME,
        title,
        type: "website",
        url,
      },
      // A collection of one or two skills is thin; the same rule as a category.
      ...(isIndexableListing(collection.itemCount) ? {} : NO_INDEX_METADATA),
      title,
      twitter: {
        card: "summary_large_image",
        description,
        images: [OG_IMAGE.url],
        title,
      },
    };
  } catch {
    return { title: t("fallbackMetaTitle") };
  }
}

export default async function PublicSkillCollectionPage({ params }: PageProps) {
  const { locale, slug } = await params;
  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }
  setRequestLocale(locale);
  const t = await getTranslations("publicSkills.collections");
  const [authState, result, categories] = await Promise.all([
    resolveInitialLandingAuthState(),
    loadCollection(decodeURIComponent(slug), locale),
    listPublicSkillCategories(),
  ]);
  const { collection, items } = result;
  const pageUrl = `${SITE_URL}${skillCollectionPath(collection.slug)}`;
  const itemListJsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: collection.title,
    url: pageUrl,
    itemListElement: items.map((skill, index) => ({
      "@type": "ListItem",
      name: skill.displayName,
      position: index + 1,
      url: `${SITE_URL}${skillPath(skill.slug)}`,
    })),
  };

  return (
    <main className="min-h-svh bg-[#f7f4ed] text-zinc-950 dark:bg-zinc-950 dark:text-white">
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
          <LocaleLink
            className="mb-8 inline-flex items-center gap-2 text-sm text-zinc-500 transition-colors hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-white"
            href="/skills"
          >
            <ArrowLeft className="size-4" />
            {t("back")}
          </LocaleLink>
          <div className="max-w-4xl">
            <span className="mb-5 inline-flex items-center gap-2 rounded-full border border-zinc-300 bg-white/48 px-3 py-1 text-xs font-medium text-zinc-600 dark:border-white/10 dark:bg-white/[0.04] dark:text-zinc-400">
              <SkillIcon className="size-3.5" />
              {t("eyebrow")}
            </span>
            <h1 className="text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
              {collection.title}
            </h1>
            {collection.summary ? (
              <p className="mt-4 max-w-2xl text-base leading-7 text-zinc-600 dark:text-zinc-300">
                {collection.summary}
              </p>
            ) : null}
            <p className="mt-3 text-sm text-zinc-500">
              {t("itemCount", { count: items.length })}
            </p>
          </div>
        </div>
      </section>

      <section className={`mx-auto py-10 ${skillsContainerClassName}`}>
        {items.length > 0 ? (
          <SkillCardGrid
            categoryNames={skillCategoryNames(categories.items)}
            skills={items}
          />
        ) : (
          <p className="rounded-xl border border-zinc-300 bg-white/54 p-10 text-center text-sm text-zinc-500 dark:border-white/10 dark:bg-white/[0.03]">
            {t("empty")}
          </p>
        )}
      </section>

      <SourceWeftFooter
        authState={authState}
        containerClassName={skillsContainerClassName}
      />
    </main>
  );
}
