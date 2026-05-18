"use client";

import Link from "next/link";
import {
  ArrowRight,
  BookOpen,
  Check,
  Files,
  Network,
  Quote,
} from "lucide-react";

import { SourceWeftFooter } from "../_landing/components/sourceweft-footer";
import { SourceWeftHeader } from "../_landing/components/sourceweft-header";
import { useLandingAuthState } from "../_landing/components/use-landing-auth-state";

const principles = [
  {
    title: "Answers should stay attached to sources",
    body: "SourceWeft is built around grounded work: citations, inspectable context, and outputs that make it clear where an answer came from.",
    icon: Quote,
  },
  {
    title: "Your workspace should meet your knowledge",
    body: "Upload files or connect tools like Notion, Google Drive, Gmail, and Slack so your existing material becomes usable without copying it into another silo.",
    icon: Network,
  },
  {
    title: "AI should help people make durable artifacts",
    body: "Beyond chat, SourceWeft is designed to turn source material into study guides, FAQs, timelines, briefings, and audio overviews you can revisit.",
    icon: Files,
  },
] as const;

const audiences = [
  "Researchers comparing notes, papers, and source collections",
  "Students turning class material into study guides and grounded explanations",
  "Writers and creators connecting ideas across drafts, clips, and references",
  "Teams that need shared context without losing the trail back to original documents",
] as const;

const direction = [
  "Deeper connected-source coverage across web, desktop, and browser extension workflows",
  "More source-grounded output formats for learning, briefing, and synthesis",
  "Sharper citation review patterns so generated work stays easy to inspect",
] as const;

export function AboutPage() {
  const authState = useLandingAuthState();
  const primaryHref = authState.isSignedIn ? "/dashboard" : "/auth/sign-in";
  const primaryLabel = authState.isSignedIn
    ? "Open Dashboard"
    : "Start for free";

  return (
    <div className="min-h-screen bg-background text-foreground">
      <SourceWeftHeader authState={authState} />
      <main>
        <section className="relative overflow-hidden border-b border-zinc-200 pt-32 pb-20 dark:border-white/[0.06]">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              backgroundImage:
                "radial-gradient(circle at 18% 14%, rgba(24,24,27,0.06), transparent 34%), linear-gradient(rgba(24,24,27,0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(24,24,27,0.035) 1px, transparent 1px)",
              backgroundSize: "100% 100%, 56px 56px, 56px 56px",
            }}
          />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 hidden dark:block"
            style={{
              backgroundImage:
                "radial-gradient(circle at 18% 14%, rgba(255,255,255,0.08), transparent 34%), linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)",
              backgroundSize: "100% 100%, 56px 56px, 56px 56px",
            }}
          />

          <div className="relative mx-auto grid max-w-6xl gap-12 px-6 lg:grid-cols-[1.1fr_0.9fr] lg:items-stretch">
            <div>
              <p className="text-xs font-medium uppercase tracking-widest text-zinc-400 dark:text-zinc-600">
                About SourceWeft
              </p>
              <h1 className="mt-5 max-w-3xl text-4xl font-bold tracking-tight text-zinc-950 sm:text-5xl lg:text-6xl dark:text-white">
                An AI notebook workspace for source-grounded thinking.
              </h1>
              <p className="mt-6 max-w-2xl text-base leading-7 text-zinc-600 sm:text-lg dark:text-zinc-400">
                SourceWeft helps people collect, connect, and reason over their
                own material. It is designed for work where the source matters:
                research, learning, writing, analysis, and team knowledge.
              </p>
              <div className="mt-8 flex flex-wrap items-center gap-3">
                <Link
                  href={primaryHref}
                  className="inline-flex items-center gap-2 rounded-lg bg-zinc-900 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-100"
                >
                  {primaryLabel}
                  <ArrowRight className="size-4" />
                </Link>
                <Link
                  href="/#features"
                  className="inline-flex items-center gap-2 rounded-lg border border-zinc-200 px-5 py-2.5 text-sm text-zinc-700 transition-colors hover:border-zinc-300 hover:bg-zinc-50 dark:border-white/16 dark:text-white dark:hover:border-white/30 dark:hover:bg-white/5"
                >
                  Explore features
                </Link>
              </div>
            </div>

            <div className="flex rounded-2xl border border-zinc-200 bg-white/80 p-6 shadow-sm backdrop-blur lg:min-h-[24rem] dark:border-white/10 dark:bg-zinc-900/70">
              <div className="flex w-full flex-col">
                <div className="flex items-start gap-4 border-b border-zinc-100 pb-6 dark:border-white/[0.08]">
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-zinc-950 text-white dark:bg-white dark:text-zinc-950">
                    <BookOpen className="size-5" />
                  </span>
                  <div>
                    <p className="text-sm font-semibold text-zinc-950 dark:text-white">
                      Built for connected knowledge
                    </p>
                    <p className="text-xs text-zinc-500 dark:text-zinc-500">
                      Sources in, cited outputs out
                    </p>
                  </div>
                </div>
                <div className="mt-6 grid gap-3 text-sm">
                  {[
                    "Connected sources",
                    "Inline citations",
                    "Study guides and FAQs",
                    "Audio overviews",
                  ].map((item) => (
                    <div
                      key={item}
                      className="flex items-center gap-3 rounded-xl border border-zinc-100 bg-zinc-50 px-3 py-2.5 text-zinc-700 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-zinc-300"
                    >
                      <Check className="size-4 text-emerald-500" />
                      {item}
                    </div>
                  ))}
                </div>
                <p className="mt-auto pt-6 text-sm leading-6 text-zinc-500 dark:text-zinc-400">
                  Each output is meant to stay close to the documents, notes,
                  and connected sources that shaped it.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="py-20">
          <div className="mx-auto max-w-6xl px-6">
            <div className="mb-10 max-w-2xl">
              <p className="mb-3 text-xs font-medium uppercase tracking-widest text-zinc-400 dark:text-zinc-600">
                Product principles
              </p>
              <h2 className="text-3xl font-bold tracking-tight text-zinc-950 dark:text-white">
                Keep the thread back to the original material.
              </h2>
            </div>
            <div className="grid gap-4 md:grid-cols-3">
              {principles.map((principle) => {
                const Icon = principle.icon;

                return (
                  <article
                    key={principle.title}
                    className="rounded-2xl border border-zinc-200 bg-zinc-50 p-6 dark:border-white/[0.08] dark:bg-zinc-900/40"
                  >
                    <div className="mb-5 flex h-10 w-10 items-center justify-center rounded-xl border border-zinc-200 bg-white text-zinc-700 dark:border-white/10 dark:bg-zinc-800 dark:text-zinc-200">
                      <Icon className="size-5" />
                    </div>
                    <h3 className="text-base font-semibold text-zinc-950 dark:text-white">
                      {principle.title}
                    </h3>
                    <p className="mt-3 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
                      {principle.body}
                    </p>
                  </article>
                );
              })}
            </div>
          </div>
        </section>

        <section className="border-t border-zinc-200 py-20 dark:border-white/[0.06]">
          <div className="mx-auto grid max-w-6xl gap-10 px-6 lg:grid-cols-2">
            <div>
              <p className="mb-3 text-xs font-medium uppercase tracking-widest text-zinc-400 dark:text-zinc-600">
                Who it is for
              </p>
              <h2 className="text-3xl font-bold tracking-tight text-zinc-950 dark:text-white">
                People who need answers they can trace.
              </h2>
              <ul className="mt-7 space-y-3">
                {audiences.map((item) => (
                  <li
                    key={item}
                    className="flex gap-3 text-sm leading-6 text-zinc-600 dark:text-zinc-400"
                  >
                    <Check className="mt-1 size-4 shrink-0 text-emerald-500" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded-2xl border border-zinc-200 bg-white p-6 dark:border-white/[0.08] dark:bg-zinc-900/50">
              <p className="text-xs font-medium uppercase tracking-widest text-zinc-400 dark:text-zinc-600">
                Current direction
              </p>
              <h3 className="mt-3 text-2xl font-semibold tracking-tight text-zinc-950 dark:text-white">
                Early access is focused on making connected knowledge feel
                dependable.
              </h3>
              <ul className="mt-6 space-y-4">
                {direction.map((item) => (
                  <li
                    key={item}
                    className="border-l border-zinc-200 pl-4 text-sm leading-6 text-zinc-600 dark:border-white/10 dark:text-zinc-400"
                  >
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>
      </main>
      <SourceWeftFooter authState={authState} />
    </div>
  );
}
