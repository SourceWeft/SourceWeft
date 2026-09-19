import Link from "next/link";
import {
  ArrowRight,
  BookMarked,
  CalendarDays,
  Clock3,
  FlameKindling,
  Hash,
} from "lucide-react";

import type { BlogPostSummary } from "../../../lib/blog-db";
import { toUrlSlug } from "../../../lib/slug";
import { RawImage } from "../../_components/raw-image";

export const blogContainerClassName = "max-w-7xl px-5 sm:px-6 lg:px-8";

export function blogTagPath(tag: string) {
  return `/blog/tag/${toUrlSlug(tag)}`;
}

export function TagRail({
  selectedTag,
  tags,
}: {
  selectedTag?: string;
  tags: string[];
}) {
  return (
    <div className="flex gap-2 overflow-x-auto pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {[null, ...tags].map((tag) => {
        const active = tag === null ? !selectedTag : tag === selectedTag;

        return (
          <Link
            key={tag ?? "all"}
            href={tag === null ? "/blog#all-posts" : blogTagPath(tag)}
            className={`shrink-0 rounded-full border px-4 py-2 text-sm transition-colors ${
              active
                ? "border-zinc-950 bg-zinc-950 text-white dark:border-white dark:bg-white dark:text-zinc-950"
                : "border-zinc-300 bg-white/50 text-zinc-600 hover:border-zinc-950 hover:text-zinc-950 dark:border-white/12 dark:bg-white/[0.03] dark:text-zinc-400 dark:hover:border-white/35 dark:hover:text-white"
            }`}
          >
            {tag === null ? "All Posts" : `#${tag}`}
          </Link>
        );
      })}
    </div>
  );
}

export function PostTags({ post }: { post: BlogPostSummary }) {
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

export function formatDate(date: Date | null) {
  if (!date) {
    return "Unscheduled";
  }

  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

export function PostMeta({ post }: { post: BlogPostSummary }) {
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

export function CoverVisual({
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
      <RawImage
        alt={post.coverAltText || post.title}
        className="h-full w-full object-cover"
        src={post.coverPublicUrl}
      />
    </div>
  );
}

export function FeaturedArticle({ post }: { post: BlogPostSummary }) {
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

export function PostCard({ post }: { post: BlogPostSummary }) {
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

export function EmptyBlogState() {
  return (
    <section className={`mx-auto py-16 ${blogContainerClassName}`}>
      <div className="rounded-lg border border-zinc-300 bg-white/54 p-10 text-center dark:border-white/10 dark:bg-white/[0.03]">
        <BookMarked className="mx-auto mb-4 size-8 text-zinc-400" />
        <h2 className="text-2xl font-semibold tracking-tight">
          Essays are on the way.
        </h2>
        <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-zinc-500 dark:text-zinc-400">
          No posts have been published yet. Check back soon for product essays,
          implementation guides, and research operating patterns.
        </p>
      </div>
    </section>
  );
}
