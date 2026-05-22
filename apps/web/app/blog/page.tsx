import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRight,
  BookMarked,
  CalendarDays,
  Clock3,
  FlameKindling,
  Hash,
} from "lucide-react";

import {
  listPublishedBlogPosts,
  listPublishedBlogTags,
  type BlogPostSummary,
} from "../../lib/blog-db";
import { SourceWeftFooter } from "../_landing/components/sourceweft-footer";
import { SourceWeftHeader } from "../_landing/components/sourceweft-header";
import { resolveInitialLandingAuthState } from "../_landing/auth-state-server";
import { SITE_NAME, SITE_URL } from "../seo";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  alternates: {
    canonical: `${SITE_URL}/blog`,
  },
  description:
    "Read SourceWeft essays, product updates, and technical guides on source-grounded AI notebooks, research workflows, and trustworthy retrieval.",
  openGraph: {
    description:
      "Essays, product updates, and technical guides from the SourceWeft team.",
    siteName: SITE_NAME,
    title: "SourceWeft Blog",
    type: "website",
    url: `${SITE_URL}/blog`,
  },
  title: "Blog",
};

const blogContainerClassName = "max-w-7xl px-5 sm:px-6 lg:px-8";

type SelectedTag = string | "All Posts";

function getSelectedTag(input: {
  tag?: string | string[];
  tags: string[];
}): SelectedTag {
  const value = Array.isArray(input.tag) ? input.tag[0] : input.tag;

  if (value && input.tags.includes(value)) {
    return value;
  }

  return "All Posts";
}

function TagRail({
  selectedTag,
  tags,
}: {
  selectedTag: SelectedTag;
  tags: string[];
}) {
  const items = ["All Posts", ...tags];

  return (
    <div className="flex gap-2 overflow-x-auto pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {items.map((tag) => (
        <Link
          key={tag}
          href={
            tag === "All Posts"
              ? "/blog#all-posts"
              : `/blog?tag=${encodeURIComponent(tag)}#all-posts`
          }
          className={`shrink-0 rounded-full border px-4 py-2 text-sm transition-colors ${
            tag === selectedTag
              ? "border-zinc-950 bg-zinc-950 text-white dark:border-white dark:bg-white dark:text-zinc-950"
              : "border-zinc-300 bg-white/50 text-zinc-600 hover:border-zinc-950 hover:text-zinc-950 dark:border-white/12 dark:bg-white/[0.03] dark:text-zinc-400 dark:hover:border-white/35 dark:hover:text-white"
          }`}
        >
          {tag === "All Posts" ? tag : `#${tag}`}
        </Link>
      ))}
    </div>
  );
}

function PostTags({ post }: { post: BlogPostSummary }) {
  if (post.tags.length === 0) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-zinc-500 dark:text-zinc-400">
        <Hash className="size-3.5" />
        Article
      </span>
    );
  }

  return (
    <div className="flex flex-wrap gap-2">
      {post.tags.slice(0, 3).map((tag) => (
        <span
          key={tag}
          className="rounded-full border border-zinc-300 bg-white/50 px-2.5 py-1 text-xs text-zinc-500 dark:border-white/10 dark:bg-white/[0.04] dark:text-zinc-400"
        >
          #{tag}
        </span>
      ))}
    </div>
  );
}

function formatDate(date: Date | null) {
  if (!date) {
    return "Unscheduled";
  }

  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

function PostMeta({ post }: { post: BlogPostSummary }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-zinc-500 dark:text-zinc-400">
      <span className="inline-flex items-center gap-1.5">
        <CalendarDays className="size-3.5" />
        {formatDate(post.publishedAt)}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <Clock3 className="size-3.5" />
        {post.readingTimeMinutes} min read
      </span>
    </div>
  );
}

function CoverVisual({
  compact,
  post,
}: {
  compact?: boolean;
  post: BlogPostSummary;
}) {
  if (!post.coverPublicUrl) {
    return null;
  }

  return (
    <div
      className={`overflow-hidden rounded-lg border border-zinc-300 bg-zinc-100 dark:border-white/10 dark:bg-white/[0.04] ${
        compact ? "aspect-[1.7]" : "min-h-[21rem]"
      }`}
    >
      <img
        alt={post.coverAltText || post.title}
        className="h-full w-full object-cover"
        src={post.coverPublicUrl}
      />
    </div>
  );
}

function FeaturedArticle({ post }: { post: BlogPostSummary }) {
  const hasCover = Boolean(post.coverPublicUrl);
  const label = post.featured ? "Featured" : "Latest";

  return (
    <Link
      href={post.urlPath}
      className={`group grid gap-6 rounded-lg border border-zinc-300 bg-white/58 p-3 shadow-[0_24px_90px_rgba(39,39,42,0.08)] transition-all hover:-translate-y-1 hover:border-zinc-950/40 hover:shadow-[0_28px_110px_rgba(39,39,42,0.12)] dark:border-white/10 dark:bg-white/[0.035] dark:shadow-[0_24px_90px_rgba(0,0,0,0.34)] dark:hover:border-white/35 ${
        hasCover ? "lg:grid-cols-[1fr_0.92fr]" : ""
      }`}
    >
      <div className="order-2 flex flex-col p-3 sm:p-5 lg:order-1">
        <div className="mb-10 flex items-center justify-between gap-3">
          <span className="inline-flex items-center gap-2 rounded-full border border-emerald-300/60 bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-700 dark:border-emerald-300/30 dark:bg-emerald-300/10 dark:text-emerald-200">
            <FlameKindling className="size-3.5" />
            {label}
          </span>
          <PostTags post={post} />
        </div>
        <div className="mt-auto">
          <p className="mb-4 text-xs font-semibold uppercase text-zinc-400">
            SourceWeft Blog
          </p>
          <h2 className="max-w-3xl text-3xl font-semibold leading-[1.05] tracking-tight text-zinc-950 sm:text-4xl lg:text-5xl dark:text-white">
            {post.title}
          </h2>
          <p className="mt-5 max-w-2xl text-base leading-7 text-zinc-600 dark:text-zinc-300">
            {post.excerpt}
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-between gap-4">
            <PostMeta post={post} />
            <span className="inline-flex items-center gap-2 text-sm font-medium text-zinc-950 dark:text-white">
              Read essay
              <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" />
            </span>
          </div>
        </div>
      </div>
      {hasCover ? (
        <div className="order-1 lg:order-2">
          <CoverVisual post={post} />
        </div>
      ) : null}
    </Link>
  );
}

function PostCard({ post }: { post: BlogPostSummary }) {
  return (
    <Link
      href={post.urlPath}
      className="group flex h-full flex-col rounded-lg border border-zinc-300 bg-white/54 p-3 transition-all hover:-translate-y-1 hover:border-zinc-950/40 hover:bg-white/82 hover:shadow-[0_20px_70px_rgba(39,39,42,0.1)] dark:border-white/10 dark:bg-white/[0.03] dark:hover:border-white/35 dark:hover:bg-white/[0.055] dark:hover:shadow-[0_20px_70px_rgba(0,0,0,0.32)]"
    >
      {post.coverPublicUrl ? <CoverVisual compact post={post} /> : null}
      <div className="flex flex-1 flex-col px-2 pb-2 pt-5">
        <div className="mb-5 flex items-start justify-between gap-3">
          <PostTags post={post} />
          <span className="text-xs text-zinc-400">
            {post.readingTimeMinutes} min read
          </span>
        </div>
        <h3 className="text-xl font-semibold leading-tight tracking-tight text-zinc-950 dark:text-white">
          {post.title}
        </h3>
        <p className="mt-3 line-clamp-3 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
          {post.excerpt}
        </p>
        <div className="mt-auto flex items-center justify-between gap-4 pt-7">
          <span className="text-xs text-zinc-400">
            {formatDate(post.publishedAt)}
          </span>
          <span className="inline-flex size-8 items-center justify-center rounded-full border border-zinc-200 bg-white text-zinc-500 transition-colors group-hover:border-zinc-950 group-hover:text-zinc-950 dark:border-white/10 dark:bg-white/[0.04] dark:text-zinc-400 dark:group-hover:border-white/35 dark:group-hover:text-white">
            <ArrowRight className="size-4" />
          </span>
        </div>
      </div>
    </Link>
  );
}

function EmptyBlogState() {
  return (
    <section className="mx-auto max-w-7xl px-5 py-16 sm:px-6 lg:px-8">
      <div className="rounded-lg border border-zinc-300 bg-white/54 p-10 text-center dark:border-white/10 dark:bg-white/[0.03]">
        <BookMarked className="mx-auto mb-4 size-8 text-zinc-400" />
        <h2 className="text-2xl font-semibold tracking-tight">
          Blog posts are syncing soon.
        </h2>
        <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-zinc-500 dark:text-zinc-400">
          Published Notion rows with `Sync` enabled will appear here after the
          manual blog sync command writes them to Postgres.
        </p>
      </div>
    </section>
  );
}

export default async function BlogIndexPage({
  searchParams,
}: {
  searchParams: Promise<{ tag?: string | string[] }>;
}) {
  const { tag } = await searchParams;
  const [initialAuthState, posts, tags] = await Promise.all([
    resolveInitialLandingAuthState(),
    listPublishedBlogPosts(),
    listPublishedBlogTags(),
  ]);
  const selectedTag = getSelectedTag({ tag, tags });
  const scopedPosts =
    selectedTag === "All Posts"
      ? posts
      : posts.filter((post) => post.tags.includes(selectedTag));
  const featuredPost =
    scopedPosts.find((post) => post.featured) ?? scopedPosts[0] ?? null;
  const visiblePosts =
    selectedTag === "All Posts"
      ? posts.filter((post) => post.id !== featuredPost?.id)
      : scopedPosts.filter((post) => post.id !== featuredPost?.id);

  return (
    <main className="min-h-svh bg-[#f7f4ed] text-zinc-950 dark:bg-zinc-950 dark:text-white">
      <SourceWeftHeader
        authState={initialAuthState}
        containerClassName={blogContainerClassName}
      />
      <section className="relative overflow-hidden border-b border-zinc-300 dark:border-white/10">
        <div
          aria-hidden
          className="absolute inset-0 bg-[linear-gradient(rgba(24,24,27,0.055)_1px,transparent_1px),linear-gradient(90deg,rgba(24,24,27,0.055)_1px,transparent_1px)] bg-[size:42px_42px] dark:bg-[linear-gradient(rgba(255,255,255,0.045)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.045)_1px,transparent_1px)]"
        />
        <div className="relative mx-auto max-w-7xl px-5 pb-12 pt-28 sm:px-6 lg:px-8 lg:pb-16 lg:pt-32">
          <div className="grid gap-10 lg:grid-cols-[0.9fr_1.1fr] lg:items-end">
            <div>
              <span className="mb-6 inline-flex items-center gap-2 rounded-full border border-zinc-300 bg-white/48 px-3 py-1 text-xs font-medium text-zinc-600 dark:border-white/10 dark:bg-white/[0.04] dark:text-zinc-400">
                <BookMarked className="size-3.5" />
                SourceWeft Blog
              </span>
              <h1 className="max-w-4xl text-5xl font-semibold leading-[0.95] tracking-tight text-zinc-950 sm:text-6xl lg:text-7xl dark:text-white">
                Field notes for AI workspaces.
              </h1>
            </div>
            <div className="lg:pb-2">
              <p className="max-w-2xl text-lg leading-8 text-zinc-600 dark:text-zinc-300">
                Product essays, implementation guides, and research operating
                patterns for teams building with connected knowledge sources.
              </p>
              <p className="mt-7 max-w-lg border-l border-zinc-300 pl-4 text-sm leading-6 text-zinc-500 dark:border-white/12 dark:text-zinc-400">
                Browse essays by topic, from model evaluation to research
                operations and product updates.
              </p>
            </div>
          </div>
          <div className="mt-12 border-t border-zinc-300 pt-6 dark:border-white/10">
            <TagRail selectedTag={selectedTag} tags={tags} />
          </div>
        </div>
      </section>

      {featuredPost ? (
        <section className="mx-auto max-w-7xl px-5 py-10 sm:px-6 lg:px-8 lg:py-14">
          <FeaturedArticle post={featuredPost} />
        </section>
      ) : (
        <EmptyBlogState />
      )}

      <section
        id="all-posts"
        className="mx-auto max-w-7xl px-5 pb-16 sm:px-6 lg:px-8"
      >
        <div className="mb-8 flex flex-col justify-between gap-4 border-t border-zinc-300 pt-8 sm:flex-row sm:items-end dark:border-white/10">
          <div>
            <p className="text-xs font-semibold uppercase text-zinc-400">
              Latest writing
            </p>
            <h2 className="mt-2 text-3xl font-semibold tracking-tight">
              {selectedTag === "All Posts"
                ? "Guides, updates, and systems notes"
                : `#${selectedTag} essays`}
            </h2>
          </div>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            {selectedTag === "All Posts"
              ? `${posts.length} essays from the product and engineering team`
              : `${scopedPosts.length} essays tagged #${selectedTag}`}
          </p>
        </div>
        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          {visiblePosts.map((post) => (
            <PostCard key={post.id} post={post} />
          ))}
        </div>
        {visiblePosts.length === 0 && posts.length > 0 ? (
          <div className="rounded-lg border border-zinc-300 bg-white/54 p-10 text-center dark:border-white/10 dark:bg-white/[0.03]">
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              No posts with this tag yet.
            </p>
          </div>
        ) : null}
      </section>

      <SourceWeftFooter containerClassName={blogContainerClassName} />
    </main>
  );
}
