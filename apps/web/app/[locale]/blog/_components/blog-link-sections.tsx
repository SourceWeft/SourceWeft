import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { DEFAULT_LOCALE, isLocale } from "@sourceweft/i18n/locales";
import { addLocalePrefix } from "@sourceweft/i18n/resolve";
import { getLocale, getTranslations } from "next-intl/server";

import {
  listBlogPostsForLinkBlock,
  type BlogPostSummary,
} from "../../../../lib/blog-db";
import {
  latestBlogPosts,
  selectGuidePosts,
  type GuideDirectory,
} from "../../../../lib/blog-links";
import { marketingContainerClassName } from "../../../_landing/components/marketing-container";
import { formatDate } from "./blog-list";

const HOME_LATEST_ARTICLES = 4;
// The directory front page lists every guide for the directory (nine today);
// a category page keeps to a short list led by the category's own articles.
const DIRECTORY_GUIDES = 12;
const CATEGORY_GUIDES = 4;

async function activeUiLocale() {
  const locale = await getLocale();
  return isLocale(locale) ? locale : DEFAULT_LOCALE;
}

async function ArticleLink({ post }: { post: BlogPostSummary }) {
  const t = await getTranslations("blog");
  const published = formatDate(post.publishedAt);
  return (
    <Link
      href={post.urlPath}
      className="group flex h-full flex-col rounded-xl border border-zinc-300 bg-white/50 p-5 transition-colors hover:border-zinc-950 hover:bg-white dark:border-white/10 dark:bg-white/[0.03] dark:hover:border-white/35 dark:hover:bg-white/[0.055]"
    >
      <h3 className="text-base font-semibold leading-snug tracking-tight text-zinc-950 dark:text-white">
        {post.title}
      </h3>
      <p className="mt-2 line-clamp-2 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
        {post.excerpt}
      </p>
      <span className="mt-auto flex items-center justify-between gap-3 pt-4 text-xs text-zinc-500 dark:text-zinc-400">
        <span>
          {published ? `${published} · ` : ""}
          {t("minRead", { minutes: post.readingTimeMinutes })}
        </span>
        <ArrowRight
          aria-hidden
          className="size-4 transition-transform group-hover:translate-x-0.5"
        />
      </span>
    </Link>
  );
}

function SectionHeading({
  allHref,
  allLabel,
  eyebrow,
  heading,
}: {
  allHref: string;
  allLabel: string;
  eyebrow: string;
  heading: string;
}) {
  return (
    <div className="mb-6 flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
          {eyebrow}
        </p>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight text-zinc-950 dark:text-white">
          {heading}
        </h2>
      </div>
      <Link
        href={allHref}
        className="inline-flex items-center gap-1.5 text-sm font-medium text-zinc-950 dark:text-white"
      >
        {allLabel}
        <ArrowRight aria-hidden className="size-4" />
      </Link>
    </div>
  );
}

/** Home page: the newest published articles in the visitor's language. */
export async function LatestArticlesSection() {
  const locale = await activeUiLocale();
  const posts = latestBlogPosts(
    await listBlogPostsForLinkBlock(locale),
    HOME_LATEST_ARTICLES,
  );
  if (posts.length === 0) {
    return null;
  }
  const t = await getTranslations("blog.home");
  return (
    <section
      id="latest-articles"
      className="border-t border-zinc-200 py-20 dark:border-white/[0.06]"
    >
      <div className={`mx-auto ${marketingContainerClassName}`}>
        <SectionHeading
          allHref={addLocalePrefix("/blog", locale)}
          allLabel={t("viewAll")}
          eyebrow={t("eyebrow")}
          heading={t("heading")}
        />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {posts.map((post) => (
            <ArticleLink key={post.id} post={post} />
          ))}
        </div>
      </div>
    </section>
  );
}

/** MCP and skills directory pages: the articles `selectGuidePosts` picks. */
export async function BlogGuidesSection({
  categorySlug,
  directory,
}: {
  categorySlug?: string;
  directory: GuideDirectory;
}) {
  const locale = await activeUiLocale();
  const posts = selectGuidePosts(await listBlogPostsForLinkBlock(locale), {
    categorySlug,
    directory,
    limit: categorySlug ? CATEGORY_GUIDES : DIRECTORY_GUIDES,
  });
  if (posts.length === 0) {
    return null;
  }
  const t = await getTranslations("blog.guides");
  return (
    <section
      id="guides"
      className={`mx-auto pb-14 pt-2 ${marketingContainerClassName}`}
    >
      <div className="border-t border-zinc-300 pt-10 dark:border-white/10">
        <SectionHeading
          allHref={addLocalePrefix("/blog", locale)}
          allLabel={t("viewAll")}
          eyebrow={t("eyebrow")}
          heading={t(`heading.${directory}`)}
        />
        <div
          className={`grid gap-4 sm:grid-cols-2 ${
            categorySlug ? "lg:grid-cols-4" : "lg:grid-cols-3"
          }`}
        >
          {posts.map((post) => (
            <ArticleLink key={post.id} post={post} />
          ))}
        </div>
      </div>
    </section>
  );
}
