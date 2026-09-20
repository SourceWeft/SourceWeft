import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Clock3,
  LinkIcon,
} from "lucide-react";
import { DEFAULT_LOCALE, isLocale, type Locale } from "@sourceweft/i18n/locales";
import { addLocalePrefix } from "@sourceweft/i18n/resolve";
import { getLocale, getTranslations } from "next-intl/server";

import {
  absoluteBlogPostUrl,
  blogPostPath,
  getBlogArticleSiblings,
  listRelatedBlogPosts,
  getPublishedBlogPost,
  type BlogPostDetail,
  type BlogPostSummary,
} from "../../../lib/blog-db";
import { CopyShareUrlButton } from "./copy-share-url-button";
import { SourceWeftFooter } from "../../_landing/components/sourceweft-footer";
import { SourceWeftHeader } from "../../_landing/components/sourceweft-header";
import { resolveInitialLandingAuthState } from "../../_landing/auth-state-server";
import { RawImage } from "../../_components/raw-image";
import { JsonLd } from "../../_components/seo/json-ld";
import { blogTagPath } from "./_components/blog-list";
import { NO_INDEX_METADATA, OG_IMAGE, SITE_NAME, SITE_URL } from "../../seo";

const blogContainerClassName = "max-w-7xl px-5 sm:px-6 lg:px-8";

function uiLocale(value: string): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

export async function generateBlogArticleMetadata(input: {
  slug: string;
  locale: Locale;
}): Promise<Metadata> {
  const post = await getPublishedBlogPost(input.slug, input.locale);

  if (!post) {
    return {
      ...NO_INDEX_METADATA,
      title: "Post Not Found",
    };
  }

  const title = post.seoTitle || post.title;
  const description = post.seoDescription || post.excerpt;
  const postLocale = uiLocale(post.locale);
  // Canonical points at the article's own language URL; hreflang links only the
  // locales this article was actually translated into (§17.3 B4).
  const canonicalUrl =
    post.canonicalUrl ||
    `${SITE_URL}${addLocalePrefix(blogPostPath(post.slug), postLocale)}`;
  const siblings = await getBlogArticleSiblings(post.articleId);
  const languages = Object.fromEntries(
    siblings.map((sibling) => [
      sibling.locale,
      `${SITE_URL}${addLocalePrefix(blogPostPath(sibling.slug), sibling.locale)}`,
    ]),
  );
  const imageUrl = post.ogImagePublicUrl || post.coverPublicUrl || OG_IMAGE.url;

  return {
    alternates: {
      canonical: canonicalUrl,
      ...(Object.keys(languages).length > 1 ? { languages } : {}),
    },
    description,
    openGraph: {
      description,
      images: [{ alt: post.title, url: imageUrl }],
      locale: post.locale,
      siteName: SITE_NAME,
      title,
      type: "article",
      url: canonicalUrl,
    },
    title,
    twitter: {
      card: "summary_large_image",
      description,
      images: [imageUrl],
      title,
    },
  };
}

// Blog content is English; dates stay in the English format to read consistently
// beside the English article body (§17.3).
function formatDate(date: Date | null) {
  return date
    ? new Intl.DateTimeFormat("en", {
        day: "numeric",
        month: "short",
        year: "numeric",
      }).format(date)
    : null;
}

function getAuthorInitials(authorName: string) {
  const words = authorName.trim().split(/\s+/).filter(Boolean);

  if (words.length >= 2) {
    return words
      .slice(0, 2)
      .map((word) => Array.from(word)[0])
      .join("")
      .toUpperCase();
  }

  return Array.from(words[0] ?? authorName.trim())
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

function getShareUrl(post: BlogPostDetail) {
  if (!post.canonicalUrl) {
    return absoluteBlogPostUrl(post.slug);
  }

  try {
    return new URL(post.canonicalUrl, SITE_URL).toString();
  } catch {
    return absoluteBlogPostUrl(post.slug);
  }
}

async function ArticleMeta({ post }: { post: BlogPostDetail }) {
  const t = await getTranslations("blog");
  const authorName = post.authorName?.trim();
  const published = formatDate(post.publishedAt);

  return (
    <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-3 text-sm text-zinc-500 dark:text-zinc-400">
      {authorName ? (
        <span className="inline-flex items-center gap-1.5 text-zinc-700 dark:text-zinc-200">
          <span className="grid size-6 place-items-center rounded-full border border-zinc-300 bg-zinc-950 text-[10px] font-semibold leading-none text-white dark:border-white/15 dark:bg-white dark:text-zinc-950">
            {getAuthorInitials(authorName)}
          </span>
          <span>{authorName}</span>
        </span>
      ) : null}
      {authorName ? (
        <span className="hidden h-1 w-1 rounded-full bg-zinc-300 sm:block dark:bg-zinc-700" />
      ) : null}
      <span className="inline-flex items-center gap-1.5">
        <CalendarDays className="size-4" />
        {published ?? t("unscheduled")}
      </span>
      <span className="hidden h-1 w-1 rounded-full bg-zinc-300 sm:block dark:bg-zinc-700" />
      <span className="inline-flex items-center gap-1.5">
        <Clock3 className="size-4" />
        {t("minRead", { minutes: post.readingTimeMinutes })}
      </span>
    </div>
  );
}

function HeroMedia({ post }: { post: BlogPostDetail }) {
  if (!post.coverPublicUrl) {
    return null;
  }

  return (
    <figure className="mb-10 aspect-[1.91/1] w-full overflow-hidden rounded-lg border border-zinc-300 bg-zinc-100 shadow-[0_18px_60px_rgba(39,39,42,0.08)] dark:border-white/10 dark:bg-white/[0.04] dark:shadow-[0_18px_50px_rgba(0,0,0,0.28)]">
      <RawImage
        alt={post.coverAltText || post.title}
        className="block h-full w-full object-contain"
        src={post.coverPublicUrl}
      />
    </figure>
  );
}

async function BlogTagList({ post }: { post: BlogPostSummary }) {
  if (post.tags.length === 0) {
    return null;
  }
  const locale = uiLocale(await getLocale());

  return (
    <>
      {post.tags.map((tag) => (
        <Link
          key={tag}
          href={addLocalePrefix(blogTagPath(tag), locale)}
          className="rounded-full border border-zinc-300 bg-white/40 px-3 py-1 text-xs text-zinc-500 transition-colors hover:border-zinc-950 hover:text-zinc-950 dark:border-white/10 dark:bg-white/[0.03] dark:text-zinc-500 dark:hover:border-white/35 dark:hover:text-white"
        >
          #{tag}
        </Link>
      ))}
    </>
  );
}

function ArticleBody({ post }: { post: BlogPostDetail }) {
  return (
    <article
      className="blog-content"
      dangerouslySetInnerHTML={{ __html: post.contentHtml }}
    />
  );
}

async function RelatedCard({ post }: { post: BlogPostSummary }) {
  const t = await getTranslations("blog");
  return (
    <Link
      href={post.urlPath}
      className="group rounded-lg border border-zinc-300 bg-white/48 p-5 transition-all hover:-translate-y-1 hover:border-zinc-950/40 hover:bg-white/82 dark:border-white/10 dark:bg-white/[0.03] dark:hover:border-white/35 dark:hover:bg-white/[0.055]"
    >
      {post.tags.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          <BlogTagList post={post} />
        </div>
      ) : null}
      <h3
        className={`text-xl font-semibold leading-tight tracking-tight text-zinc-950 dark:text-white ${
          post.tags.length > 0 ? "mt-5" : ""
        }`}
      >
        {post.title}
      </h3>
      <p className="mt-3 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
        {post.excerpt}
      </p>
      <span className="mt-6 inline-flex items-center gap-2 text-sm font-medium text-zinc-950 dark:text-white">
        {t("article.readNext")}
        <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" />
      </span>
    </Link>
  );
}

async function ArticleFooter({
  relatedPosts,
}: {
  relatedPosts: BlogPostSummary[];
}) {
  if (relatedPosts.length === 0) {
    return null;
  }
  const t = await getTranslations("blog");
  const locale = uiLocale(await getLocale());

  return (
    <section className="border-t border-zinc-300 py-14 dark:border-white/10">
      <div className="mx-auto max-w-7xl px-5 sm:px-6 lg:px-8">
        <div className="mb-8 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
          <div>
            <p className="text-xs font-semibold uppercase text-zinc-400">
              {t("article.keepReading")}
            </p>
            <h2 className="mt-2 text-3xl font-semibold tracking-tight text-zinc-950 dark:text-white">
              {t("article.relatedEssays")}
            </h2>
          </div>
          <Link
            href={addLocalePrefix("/blog", locale)}
            className="inline-flex items-center gap-2 text-sm font-medium text-zinc-950 dark:text-white"
          >
            {t("article.allPosts")}
            <ArrowRight className="size-4" />
          </Link>
        </div>
        <div className="grid gap-5 md:grid-cols-3">
          {relatedPosts.map((relatedPost) => (
            <RelatedCard key={relatedPost.id} post={relatedPost} />
          ))}
        </div>
      </div>
    </section>
  );
}

function BlogPostingJsonLd({ post }: { post: BlogPostDetail }) {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    author: post.authorName
      ? { "@type": "Person", name: post.authorName }
      : undefined,
    dateModified: post.updatedAt?.toISOString(),
    datePublished: post.publishedAt?.toISOString(),
    description: post.seoDescription || post.excerpt,
    headline: post.seoTitle || post.title,
    image: new URL(
      post.ogImagePublicUrl || post.coverPublicUrl || OG_IMAGE.url,
      SITE_URL,
    ).toString(),
    inLanguage: post.locale,
    mainEntityOfPage: absoluteBlogPostUrl(post.slug),
    publisher: {
      "@type": "Organization",
      name: SITE_NAME,
    },
  };

  return <JsonLd data={jsonLd} />;
}

export async function BlogArticlePageContent(input: {
  slug: string;
  locale: Locale;
}) {
  const post = await getPublishedBlogPost(input.slug, input.locale);

  if (!post) {
    notFound();
  }

  const [t, initialAuthState, relatedPosts] = await Promise.all([
    getTranslations("blog"),
    resolveInitialLandingAuthState(),
    listRelatedBlogPosts({
      articleId: post.articleId,
      locale: post.locale,
      limit: 3,
      tags: post.tags,
    }),
  ]);

  const shareUrl = getShareUrl(post);
  const backHref = addLocalePrefix("/blog", input.locale);

  return (
    <main className="min-h-svh bg-[#f7f4ed] text-zinc-950 dark:bg-zinc-950 dark:text-white">
      <BlogPostingJsonLd post={post} />
      <SourceWeftHeader
        authState={initialAuthState}
        containerClassName={blogContainerClassName}
      />
      <section className="border-b border-zinc-300 dark:border-white/10">
        <div className="mx-auto max-w-7xl px-5 pb-10 pt-24 sm:px-6 lg:px-8 lg:pb-14 lg:pt-28">
          <Link
            href={backHref}
            className="mb-9 inline-flex items-center gap-2 text-sm text-zinc-500 transition-colors hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-white"
          >
            <ArrowLeft className="size-4" />
            {t("article.backToBlog")}
          </Link>
          <div className="mx-auto max-w-4xl text-center">
            {post.tags.length > 0 ? (
              <div className="mb-7 flex flex-wrap items-center justify-center gap-3">
                <BlogTagList post={post} />
              </div>
            ) : null}
            <h1 className="text-4xl font-semibold leading-[1.02] tracking-tight text-zinc-950 sm:text-5xl lg:text-6xl dark:text-white">
              {post.title}
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-zinc-600 dark:text-zinc-300">
              {post.excerpt}
            </p>
            <div className="mt-8 flex justify-center">
              <ArticleMeta post={post} />
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-3xl px-5 py-12 sm:px-6 lg:py-16">
        <HeroMedia post={post} />
        <ArticleBody post={post} />
        <div className="mt-12 border-t border-zinc-300 pt-8 dark:border-white/10">
          <div className="mb-3 flex items-center gap-2 text-sm font-medium text-zinc-500 dark:text-zinc-400">
            <LinkIcon className="size-4" />
            <span>{t("article.shareableUrl")}</span>
          </div>
          <CopyShareUrlButton url={shareUrl} />
        </div>
      </section>

      <ArticleFooter relatedPosts={relatedPosts} />
      <SourceWeftFooter containerClassName={blogContainerClassName} />
    </main>
  );
}
