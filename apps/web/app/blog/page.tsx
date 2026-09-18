import type { Metadata } from "next";
import { BookMarked } from "lucide-react";

import {
  listPublishedBlogPosts,
  listPublishedBlogTags,
} from "../../lib/blog-db";
import { SourceWeftFooter } from "../_landing/components/sourceweft-footer";
import { SourceWeftHeader } from "../_landing/components/sourceweft-header";
import { resolveInitialLandingAuthState } from "../_landing/auth-state-server";
import { OG_IMAGE, SITE_NAME, SITE_URL } from "../seo";
import {
  blogContainerClassName,
  EmptyBlogState,
  FeaturedArticle,
  PostCard,
  TagRail,
} from "./_components/blog-list";

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
    images: [OG_IMAGE],
    siteName: SITE_NAME,
    title: "SourceWeft Blog",
    type: "website",
    url: `${SITE_URL}/blog`,
  },
  title: "Blog",
  twitter: {
    card: "summary_large_image",
    description:
      "Essays, product updates, and technical guides from the SourceWeft team.",
    images: [OG_IMAGE.url],
    title: "SourceWeft Blog",
  },
};

export default async function BlogIndexPage() {
  const [initialAuthState, posts, tags] = await Promise.all([
    resolveInitialLandingAuthState(),
    listPublishedBlogPosts(),
    listPublishedBlogTags(),
  ]);
  const featuredPost = posts.find((post) => post.featured) ?? posts[0] ?? null;
  const visiblePosts = posts.filter((post) => post.id !== featuredPost?.id);

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
            <TagRail tags={tags} />
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
              Guides, updates, and systems notes
            </h2>
          </div>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            {posts.length} essays from the product and engineering team
          </p>
        </div>
        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          {visiblePosts.map((post) => (
            <PostCard key={post.id} post={post} />
          ))}
        </div>
      </section>

      <SourceWeftFooter containerClassName={blogContainerClassName} />
    </main>
  );
}
