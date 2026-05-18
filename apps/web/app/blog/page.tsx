import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRight,
  BookMarked,
  CalendarDays,
  Clock3,
  FlameKindling,
} from "lucide-react";

import { SourceWeftFooter } from "../_landing/components/sourceweft-footer";
import { SourceWeftHeader } from "../_landing/components/sourceweft-header";
import { SITE_NAME, SITE_URL } from "../seo";
import { BlogVisual } from "./blog-visual";
import {
  blogCategories,
  blogPosts,
  featuredPost,
  type BlogCategory,
  type BlogPost,
} from "./data";

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

const signedOutHeaderState = {
  isPending: false,
  isSignedIn: false,
  user: null,
} as const;


type SelectedCategory = BlogCategory | "All Posts";

function getSelectedCategory(category?: string | string[]): SelectedCategory {
  const value = Array.isArray(category) ? category[0] : category;
  const categories: readonly string[] = blogCategories;

  if (value && categories.includes(value)) {
    return value as SelectedCategory;
  }

  return "All Posts";
}

function CategoryRail({ selectedCategory }: { selectedCategory: SelectedCategory }) {
  return (
    <div className="flex gap-2 overflow-x-auto pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {blogCategories.map((category, index) => (
        <Link
          key={category}
          href={index === 0 ? "/blog#all-posts" : `/blog?category=${encodeURIComponent(category)}#all-posts`}
          className={`shrink-0 rounded-full border px-4 py-2 text-sm transition-colors ${
            category === selectedCategory
              ? "border-zinc-950 bg-zinc-950 text-white dark:border-white dark:bg-white dark:text-zinc-950"
              : "border-zinc-300 bg-white/50 text-zinc-600 hover:border-zinc-950 hover:text-zinc-950 dark:border-white/12 dark:bg-white/[0.03] dark:text-zinc-400 dark:hover:border-white/35 dark:hover:text-white"
          }`}
        >
          {category}
        </Link>
      ))}
    </div>
  );
}

function PostMeta({ post }: { post: BlogPost }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-zinc-500 dark:text-zinc-400">
      <span className="inline-flex items-center gap-1.5">
        <CalendarDays className="size-3.5" />
        {post.date}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <Clock3 className="size-3.5" />
        {post.readTime}
      </span>
    </div>
  );
}

function FeaturedArticle() {
  const Icon = featuredPost.icon;

  return (
    <Link
      href={`/blog/${featuredPost.slug}`}
      className="group grid gap-6 rounded-lg border border-zinc-300 bg-white/58 p-3 shadow-[0_24px_90px_rgba(39,39,42,0.08)] transition-all hover:-translate-y-1 hover:border-zinc-950/40 hover:shadow-[0_28px_110px_rgba(39,39,42,0.12)] lg:grid-cols-[1fr_0.92fr] dark:border-white/10 dark:bg-white/[0.035] dark:shadow-[0_24px_90px_rgba(0,0,0,0.34)] dark:hover:border-white/35"
    >
      <div className="order-2 flex flex-col p-3 sm:p-5 lg:order-1">
        <div className="mb-10 flex items-center justify-between gap-3">
          <span className="inline-flex items-center gap-2 rounded-full border border-emerald-300/60 bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-700 dark:border-emerald-300/30 dark:bg-emerald-300/10 dark:text-emerald-200">
            <FlameKindling className="size-3.5" />
            Featured
          </span>
          <span className="inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-white/70 px-3 py-1 text-xs text-zinc-500 dark:border-white/10 dark:bg-white/[0.04] dark:text-zinc-400">
            <Icon className="size-3.5" />
            {featuredPost.category}
          </span>
        </div>
        <div className="mt-auto">
          <p className="mb-4 text-xs font-semibold uppercase text-zinc-400">
            {featuredPost.heroLabel}
          </p>
          <h2 className="max-w-3xl text-3xl font-semibold leading-[1.05] tracking-tight text-zinc-950 sm:text-4xl lg:text-5xl dark:text-white">
            {featuredPost.title}
          </h2>
          <p className="mt-5 max-w-2xl text-base leading-7 text-zinc-600 dark:text-zinc-300">
            {featuredPost.description}
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-between gap-4">
            <PostMeta post={featuredPost} />
            <span className="inline-flex items-center gap-2 text-sm font-medium text-zinc-950 dark:text-white">
              Read essay
              <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" />
            </span>
          </div>
        </div>
      </div>
      <div className="order-1 lg:order-2">
        <BlogVisual accent={featuredPost.accent} visual={featuredPost.visual} />
      </div>
    </Link>
  );
}

function PostCard({ post }: { post: BlogPost }) {
  const Icon = post.icon;

  return (
    <Link
      href={`/blog/${post.slug}`}
      className="group flex h-full flex-col rounded-lg border border-zinc-300 bg-white/54 p-3 transition-all hover:-translate-y-1 hover:border-zinc-950/40 hover:bg-white/82 hover:shadow-[0_20px_70px_rgba(39,39,42,0.1)] dark:border-white/10 dark:bg-white/[0.03] dark:hover:border-white/35 dark:hover:bg-white/[0.055] dark:hover:shadow-[0_20px_70px_rgba(0,0,0,0.32)]"
    >
      <BlogVisual accent={post.accent} compact visual={post.visual} />
      <div className="flex flex-1 flex-col px-2 pb-2 pt-5">
        <div className="mb-5 flex items-center justify-between gap-3">
          <span className="inline-flex items-center gap-2 text-xs font-medium text-zinc-500 dark:text-zinc-400">
            <Icon className="size-3.5" />
            {post.category}
          </span>
          <span className="text-xs text-zinc-400">{post.readTime}</span>
        </div>
        <h3 className="text-xl font-semibold leading-tight tracking-tight text-zinc-950 dark:text-white">
          {post.title}
        </h3>
        <p className="mt-3 line-clamp-3 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
          {post.description}
        </p>
        <div className="mt-auto flex items-center justify-between gap-4 pt-7">
          <span className="text-xs text-zinc-400">{post.date}</span>
          <span className="inline-flex size-8 items-center justify-center rounded-full border border-zinc-200 bg-white text-zinc-500 transition-colors group-hover:border-zinc-950 group-hover:text-zinc-950 dark:border-white/10 dark:bg-white/[0.04] dark:text-zinc-400 dark:group-hover:border-white/35 dark:group-hover:text-white">
            <ArrowRight className="size-4" />
          </span>
        </div>
      </div>
    </Link>
  );
}

function NewsletterBand() {
  return (
    <section className="mt-20 border-y border-zinc-300 bg-[#ebe5d8] text-zinc-950 dark:border-white/10 dark:bg-zinc-900 dark:text-white">
      <div className="relative mx-auto grid max-w-7xl gap-8 overflow-hidden px-5 py-10 sm:px-6 md:grid-cols-[1fr_0.85fr] lg:px-8">
        <div
          aria-hidden
          className="absolute inset-0 bg-[linear-gradient(rgba(24,24,27,0.045)_1px,transparent_1px),linear-gradient(90deg,rgba(24,24,27,0.045)_1px,transparent_1px)] bg-[size:36px_36px] opacity-70 dark:bg-[linear-gradient(rgba(255,255,255,0.045)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.045)_1px,transparent_1px)]"
        />
        <div>
          <p className="relative mb-3 text-xs font-semibold uppercase text-emerald-700 dark:text-emerald-300">
            Research letters
          </p>
          <h2 className="relative max-w-2xl text-3xl font-semibold tracking-tight">
            Get the best SourceWeft essays when they ship.
          </h2>
        </div>
        <form className="relative flex items-center gap-2 self-end rounded-lg border border-zinc-300 bg-white/58 p-2 shadow-[0_16px_50px_rgba(39,39,42,0.08)] dark:border-white/12 dark:bg-white/[0.055] dark:shadow-none">
          <label htmlFor="blog-email" className="sr-only">
            Email address
          </label>
          <input
            id="blog-email"
            type="email"
            placeholder="team@example.com"
            className="min-w-0 flex-1 bg-transparent px-3 py-2.5 text-sm text-zinc-950 outline-none placeholder:text-zinc-500 dark:text-white dark:placeholder:text-zinc-500"
          />
          <button
            type="button"
            className="inline-flex shrink-0 items-center gap-2 rounded-md bg-zinc-950 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200"
          >
            Subscribe
          </button>
        </form>
      </div>
    </section>
  );
}

export default async function BlogIndexPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string | string[] }>;
}) {
  const { category } = await searchParams;
  const selectedCategory = getSelectedCategory(category);
  const visiblePosts =
    selectedCategory === "All Posts"
      ? blogPosts.slice(1)
      : blogPosts.filter(
          (post) =>
            post.category === selectedCategory && post.slug !== featuredPost.slug,
        );

  return (
    <main className="min-h-svh bg-[#f7f4ed] text-zinc-950 dark:bg-zinc-950 dark:text-white">
      <SourceWeftHeader authState={signedOutHeaderState} />
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
                Browse essays by discipline, from model evaluation to research
                operations and product updates.
              </p>
            </div>
          </div>
          <div className="mt-12 border-t border-zinc-300 pt-6 dark:border-white/10">
            <CategoryRail selectedCategory={selectedCategory} />
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-5 py-10 sm:px-6 lg:px-8 lg:py-14">
        <FeaturedArticle />
      </section>

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
              {selectedCategory === "All Posts"
                ? "Guides, updates, and systems notes"
                : `${selectedCategory} essays`}
            </h2>
          </div>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            {selectedCategory === "All Posts"
              ? `${blogPosts.length} essays from the product and engineering team`
              : `${visiblePosts.length} essays in ${selectedCategory}`}
          </p>
        </div>
        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          {visiblePosts.map((post) => (
            <PostCard key={post.slug} post={post} />
          ))}
        </div>
        {visiblePosts.length === 0 ? (
          <div className="rounded-lg border border-zinc-300 bg-white/54 p-10 text-center dark:border-white/10 dark:bg-white/[0.03]">
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              No posts in this topic yet.
            </p>
          </div>
        ) : null}
      </section>

      <NewsletterBand />
      <SourceWeftFooter />
    </main>
  );
}
