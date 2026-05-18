import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  Clock3,
  FileText,
  LinkIcon,
  Sparkles,
} from "lucide-react";

import { SourceWeftFooter } from "../../_landing/components/sourceweft-footer";
import { SourceWeftHeader } from "../../_landing/components/sourceweft-header";
import { SITE_NAME, SITE_URL } from "../../seo";
import { BlogVisual } from "../blog-visual";
import { blogPosts, getBlogPost, getRelatedPosts, type BlogPost } from "../data";

export function generateStaticParams() {
  return blogPosts.map((post) => ({ slug: post.slug }));
}

const signedOutHeaderState = {
  isPending: false,
  isSignedIn: false,
  user: null,
} as const;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const post = getBlogPost(slug);

  if (!post) {
    return {
      title: "Post Not Found",
    };
  }

  return {
    alternates: {
      canonical: `${SITE_URL}/blog/${post.slug}`,
    },
    description: post.description,
    openGraph: {
      description: post.description,
      siteName: SITE_NAME,
      title: post.title,
      type: "article",
      url: `${SITE_URL}/blog/${post.slug}`,
    },
    title: post.title,
  };
}

function ArticleMeta({ post }: { post: BlogPost }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-zinc-500 dark:text-zinc-400">
      <span>{post.author}</span>
      <span className="hidden h-1 w-1 rounded-full bg-zinc-300 sm:block dark:bg-zinc-700" />
      <span className="inline-flex items-center gap-1.5">
        <CalendarDays className="size-4" />
        {post.date}
      </span>
      <span className="hidden h-1 w-1 rounded-full bg-zinc-300 sm:block dark:bg-zinc-700" />
      <span className="inline-flex items-center gap-1.5">
        <Clock3 className="size-4" />
        {post.readTime}
      </span>
    </div>
  );
}

function TableOfContents({ post }: { post: BlogPost }) {
  return (
    <aside className="hidden lg:block">
      <div className="sticky top-24 rounded-lg border border-zinc-300 bg-white/46 p-5 dark:border-white/10 dark:bg-white/[0.03]">
        <p className="mb-4 text-xs font-semibold uppercase text-zinc-400">
          In this article
        </p>
        <nav className="space-y-3 text-sm">
          {post.sections.map((section) => (
            <a
              key={section.heading}
              href={`#${section.heading.toLowerCase().replaceAll(" ", "-")}`}
              className="block leading-5 text-zinc-500 transition-colors hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-white"
            >
              {section.heading}
            </a>
          ))}
        </nav>
        <div className="mt-6 rounded-md border border-zinc-200 bg-zinc-50 p-3 text-xs leading-5 text-zinc-500 dark:border-white/10 dark:bg-white/[0.04] dark:text-zinc-400">
          <Sparkles className="mb-2 size-4 text-emerald-500" />
          SourceWeft essays are written for teams that need inspectable AI
          workflows, not black-box answers.
        </div>
      </div>
    </aside>
  );
}

function KeyTakeaways({ post }: { post: BlogPost }) {
  const takeaways = post.sections.slice(0, 3).map((section) => section.heading);

  return (
    <div className="not-prose my-10 rounded-lg border border-zinc-300 bg-white/54 p-5 dark:border-white/10 dark:bg-white/[0.035]">
      <div className="mb-5 flex items-center gap-2">
        <FileText className="size-4 text-emerald-600 dark:text-emerald-300" />
        <p className="text-sm font-semibold text-zinc-950 dark:text-white">
          Key takeaways
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {takeaways.map((takeaway) => (
          <div
            key={takeaway}
            className="rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm leading-5 text-zinc-600 dark:border-white/10 dark:bg-white/[0.04] dark:text-zinc-300"
          >
            <CheckCircle2 className="mb-3 size-4 text-emerald-600 dark:text-emerald-300" />
            {takeaway}
          </div>
        ))}
      </div>
    </div>
  );
}

function ArticleBody({ post }: { post: BlogPost }) {
  return (
    <article className="max-w-none">
      <KeyTakeaways post={post} />
      <div className="space-y-12">
        {post.sections.map((section) => (
          <section
            key={section.heading}
            id={section.heading.toLowerCase().replaceAll(" ", "-")}
            className="scroll-mt-28"
          >
            <h2 className="text-2xl font-semibold tracking-tight text-zinc-950 dark:text-white">
              {section.heading}
            </h2>
            <div className="mt-5 space-y-5 text-lg leading-8 text-zinc-700 dark:text-zinc-300">
              {section.body.map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
            </div>
            {section.bullets ? (
              <ul className="mt-6 space-y-3">
                {section.bullets.map((bullet) => (
                  <li
                    key={bullet}
                    className="flex gap-3 rounded-lg border border-zinc-300 bg-white/46 p-4 text-base leading-7 text-zinc-700 dark:border-white/10 dark:bg-white/[0.03] dark:text-zinc-300"
                  >
                    <CheckCircle2 className="mt-1 size-5 shrink-0 text-emerald-600 dark:text-emerald-300" />
                    <span>{bullet}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        ))}
      </div>
    </article>
  );
}

function RelatedCard({ post }: { post: BlogPost }) {
  const Icon = post.icon;

  return (
    <Link
      href={`/blog/${post.slug}`}
      className="group rounded-lg border border-zinc-300 bg-white/48 p-5 transition-all hover:-translate-y-1 hover:border-zinc-950/40 hover:bg-white/82 dark:border-white/10 dark:bg-white/[0.03] dark:hover:border-white/35 dark:hover:bg-white/[0.055]"
    >
      <span className="inline-flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
        <Icon className="size-3.5" />
        {post.category}
      </span>
      <h3 className="mt-5 text-xl font-semibold leading-tight tracking-tight text-zinc-950 dark:text-white">
        {post.title}
      </h3>
      <p className="mt-3 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
        {post.description}
      </p>
      <span className="mt-6 inline-flex items-center gap-2 text-sm font-medium text-zinc-950 dark:text-white">
        Read next
        <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" />
      </span>
    </Link>
  );
}

function ArticleFooter({ post }: { post: BlogPost }) {
  const relatedPosts = getRelatedPosts(post.slug);

  return (
    <section className="border-t border-zinc-300 py-14 dark:border-white/10">
      <div className="mx-auto max-w-7xl px-5 sm:px-6 lg:px-8">
        <div className="mb-8 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
          <div>
            <p className="text-xs font-semibold uppercase text-zinc-400">
              Keep reading
            </p>
            <h2 className="mt-2 text-3xl font-semibold tracking-tight text-zinc-950 dark:text-white">
              Related essays
            </h2>
          </div>
          <Link
            href="/blog"
            className="inline-flex items-center gap-2 text-sm font-medium text-zinc-950 dark:text-white"
          >
            All posts
            <ArrowRight className="size-4" />
          </Link>
        </div>
        <div className="grid gap-5 md:grid-cols-3">
          {relatedPosts.map((relatedPost) => (
            <RelatedCard key={relatedPost.slug} post={relatedPost} />
          ))}
        </div>
      </div>
    </section>
  );
}

export default async function BlogArticlePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const post = getBlogPost(slug);

  if (!post) {
    notFound();
  }

  const Icon = post.icon;

  return (
    <main className="min-h-svh bg-[#f7f4ed] text-zinc-950 dark:bg-zinc-950 dark:text-white">
      <SourceWeftHeader authState={signedOutHeaderState} />
      <section className="border-b border-zinc-300 dark:border-white/10">
        <div className="mx-auto max-w-7xl px-5 pb-10 pt-24 sm:px-6 lg:px-8 lg:pb-14 lg:pt-28">
          <Link
            href="/blog"
            className="mb-9 inline-flex items-center gap-2 text-sm text-zinc-500 transition-colors hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-white"
          >
            <ArrowLeft className="size-4" />
            Back to blog
          </Link>
          <div className="grid gap-8 lg:grid-cols-[0.95fr_0.9fr] lg:items-end">
            <div>
              <div className="mb-7 flex flex-wrap items-center gap-3">
                <span className="inline-flex items-center gap-2 rounded-full border border-zinc-300 bg-white/50 px-3 py-1 text-xs font-medium text-zinc-600 dark:border-white/10 dark:bg-white/[0.04] dark:text-zinc-400">
                  <Icon className="size-3.5" />
                  {post.category}
                </span>
                {post.tags.map((tag) => (
                  <span
                    key={tag}
                    className="rounded-full border border-zinc-300 px-3 py-1 text-xs text-zinc-500 dark:border-white/10 dark:text-zinc-500"
                  >
                    {tag}
                  </span>
                ))}
              </div>
              <h1 className="max-w-4xl text-4xl font-semibold leading-[1.02] tracking-tight text-zinc-950 sm:text-5xl lg:text-6xl dark:text-white">
                {post.title}
              </h1>
              <p className="mt-6 max-w-2xl text-lg leading-8 text-zinc-600 dark:text-zinc-300">
                {post.description}
              </p>
              <div className="mt-8">
                <ArticleMeta post={post} />
              </div>
            </div>
            <BlogVisual accent={post.accent} visual={post.visual} />
          </div>
        </div>
      </section>

      <section className="mx-auto grid max-w-7xl gap-10 px-5 py-12 sm:px-6 lg:grid-cols-[1fr_17rem] lg:px-8 lg:py-16">
        <div className="min-w-0">
          <ArticleBody post={post} />
          <div className="mt-12 flex flex-wrap items-center gap-3 border-t border-zinc-300 pt-8 text-sm text-zinc-500 dark:border-white/10 dark:text-zinc-400">
            <LinkIcon className="size-4" />
            <span>Shareable URL:</span>
            <code className="rounded-md border border-zinc-300 bg-white/52 px-2 py-1 text-xs text-zinc-600 dark:border-white/10 dark:bg-white/[0.04] dark:text-zinc-300">
              /blog/{post.slug}
            </code>
          </div>
        </div>
        <TableOfContents post={post} />
      </section>

      <ArticleFooter post={post} />
      <SourceWeftFooter />
    </main>
  );
}
