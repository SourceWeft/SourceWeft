import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Hash } from "lucide-react";

import {
  listPublishedBlogPosts,
  listPublishedBlogTags,
  type BlogPostSummary,
} from "../../../../lib/blog-db";
import { toUrlSlug } from "../../../../lib/slug";
import { SourceWeftFooter } from "../../../_landing/components/sourceweft-footer";
import { SourceWeftHeader } from "../../../_landing/components/sourceweft-header";
import { resolveInitialLandingAuthState } from "../../../_landing/auth-state-server";
import {
  isIndexableListing,
  NO_INDEX_METADATA,
  OG_IMAGE,
  SITE_NAME,
  SITE_URL,
} from "../../../seo";
import {
  blogContainerClassName,
  blogTagPath,
  PostCard,
  TagRail,
} from "../../_components/blog-list";

// Canonical and OG URLs embed the public site URL, which is injected at
// container start, so this must never be prerendered at build time.
export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ slug: string }>;
};

async function resolveTag(slug: string) {
  const tags = await listPublishedBlogTags();
  return tags.find((tag) => toUrlSlug(tag) === slug) ?? null;
}

function postsForTag(posts: BlogPostSummary[], tag: string) {
  return posts.filter((post) => post.tags.includes(tag));
}

function tagDescription(tag: string, count: number) {
  return `${count} SourceWeft ${count === 1 ? "essay" : "essays"} tagged #${tag}: product notes, implementation guides, and research workflows.`;
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const tag = await resolveTag(decodeURIComponent(slug));

  if (!tag) {
    return { ...NO_INDEX_METADATA, title: "Tag Not Found" };
  }

  const posts = postsForTag(await listPublishedBlogPosts(), tag);
  const title = `#${tag} essays`;
  const description = tagDescription(tag, posts.length);
  const url = `${SITE_URL}${blogTagPath(tag)}`;

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
    ...(isIndexableListing(posts.length) ? {} : NO_INDEX_METADATA),
    title,
    twitter: {
      card: "summary_large_image",
      description,
      images: [OG_IMAGE.url],
      title,
    },
  };
}

export default async function BlogTagPage({ params }: PageProps) {
  const { slug } = await params;
  const decodedSlug = decodeURIComponent(slug);
  const [initialAuthState, allPosts, tags] = await Promise.all([
    resolveInitialLandingAuthState(),
    listPublishedBlogPosts(),
    listPublishedBlogTags(),
  ]);
  const tag = tags.find((candidate) => toUrlSlug(candidate) === decodedSlug);

  if (!tag) {
    notFound();
  }

  const posts = postsForTag(allPosts, tag);

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
        <div
          className={`relative mx-auto pb-12 pt-24 sm:px-6 lg:pb-16 lg:pt-28 ${blogContainerClassName}`}
        >
          <Link
            className="mb-8 inline-flex items-center gap-2 text-sm text-zinc-500 transition-colors hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-white"
            href="/blog"
          >
            <ArrowLeft className="size-4" />
            Back to blog
          </Link>
          <div className="max-w-4xl">
            <span className="mb-6 inline-flex items-center gap-2 rounded-full border border-zinc-300 bg-white/48 px-3 py-1 text-xs font-medium text-zinc-600 dark:border-white/10 dark:bg-white/[0.04] dark:text-zinc-400">
              <Hash className="size-3.5" />
              Topic
            </span>
            <h1 className="text-5xl font-semibold leading-[0.95] tracking-tight text-zinc-950 sm:text-6xl dark:text-white">
              #{tag}
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-zinc-600 dark:text-zinc-300">
              {tagDescription(tag, posts.length)}
            </p>
          </div>
          <div className="mt-12 border-t border-zinc-300 pt-6 dark:border-white/10">
            <TagRail selectedTag={tag} tags={tags} />
          </div>
        </div>
      </section>

      <section className={`mx-auto py-12 ${blogContainerClassName}`}>
        {posts.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            No published essays carry this tag yet.{" "}
            <Link className="underline underline-offset-4" href="/blog">
              Browse all essays
            </Link>
            .
          </p>
        ) : (
          <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
            {posts.map((post) => (
              <PostCard key={post.id} post={post} />
            ))}
          </div>
        )}
      </section>

      <SourceWeftFooter
        authState={initialAuthState}
        containerClassName={blogContainerClassName}
      />
    </main>
  );
}
