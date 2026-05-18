"use client";

import Link from "next/link";
import { ArrowRight, Check, GitCommit, Sparkles, Tag } from "lucide-react";

import { SourceWeftFooter } from "../_landing/components/sourceweft-footer";
import { SourceWeftHeader } from "../_landing/components/sourceweft-header";
import { useLandingAuthState } from "../_landing/components/use-landing-auth-state";

type ChangelogEntry = {
  date: string;
  title: string;
  tag: string;
  commit: string;
  category: "Release";
  summary: string;
  items: string[];
};

const changelogEntries: ChangelogEntry[] = [
  {
    date: "May 18, 2026",
    title: "Expand model catalog discovery and dashboard performance",
    tag: "v0.2.0-test.1",
    commit: "da3bcd8",
    category: "Release",
    summary:
      "This test release expands model catalog discovery for global gateways and BYOK credentials, then improves dashboard and chat rendering paths.",
    items: [
      "Added dynamic model catalog discovery for global gateways and BYOK credentials, including LiteLLM capability matching and BYOK model candidate APIs.",
      "Moved model catalog sync configuration into `model-gateway.global.json` and documented the gateway-level behavior.",
      "Split chat thread streaming logic into focused parser, request body, render buffer, runner control, and event handler modules.",
      "Improved dashboard rendering performance with richer route skeletons, memoized and virtualized chat/source UI paths, observability layout updates, and cached skills catalog loading.",
    ],
  },
  {
    date: "May 17, 2026",
    title: "Skip startup pricing sync",
    tag: "v0.1.0-test.1",
    commit: "4f21442",
    category: "Release",
    summary:
      "This test release changes startup behavior so pricing synchronization is skipped during normal API and worker boot.",
    items: [
      "Updated backend API startup to avoid running pricing sync as part of service initialization.",
      "Updated worker startup with the same pricing sync skip behavior.",
      "Adjusted model gateway config sync handling for the new startup path.",
    ],
  },
];

const categoryClassName = {
  Release:
    "border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-white/10 dark:bg-white/[0.04] dark:text-zinc-300",
} satisfies Record<ChangelogEntry["category"], string>;

export function ChangelogPage() {
  const authState = useLandingAuthState();

  return (
    <div className="min-h-screen bg-background text-foreground">
      <SourceWeftHeader authState={authState} />
      <main>
        <section className="relative overflow-hidden border-b border-zinc-200 pt-32 pb-16 dark:border-white/[0.06]">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              backgroundImage:
                "radial-gradient(circle at 76% 20%, rgba(14,165,233,0.08), transparent 30%), linear-gradient(rgba(24,24,27,0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(24,24,27,0.035) 1px, transparent 1px)",
              backgroundSize: "100% 100%, 56px 56px, 56px 56px",
            }}
          />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 hidden dark:block"
            style={{
              backgroundImage:
                "radial-gradient(circle at 76% 20%, rgba(14,165,233,0.12), transparent 30%), linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)",
              backgroundSize: "100% 100%, 56px 56px, 56px 56px",
            }}
          />
          <div className="relative mx-auto max-w-6xl px-6">
            <div className="max-w-3xl">
              <p className="inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-white px-3 py-1 text-xs font-medium text-zinc-500 shadow-sm dark:border-white/10 dark:bg-zinc-900 dark:text-zinc-400">
                <Sparkles className="size-3.5" />
                Product updates
              </p>
              <h1 className="mt-5 text-4xl font-bold tracking-tight text-zinc-950 sm:text-5xl lg:text-6xl dark:text-white">
                Changelog
              </h1>
              <p className="mt-5 max-w-2xl text-base leading-7 text-zinc-600 sm:text-lg dark:text-zinc-400">
                A concise record of SourceWeft releases, written from Git tags
                so public updates stay tied to shipped code.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <Link
                  href="/about"
                  className="inline-flex items-center gap-2 rounded-lg bg-zinc-900 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-100"
                >
                  About SourceWeft
                  <ArrowRight className="size-4" />
                </Link>
                <Link
                  href="/#features"
                  className="inline-flex items-center gap-2 rounded-lg border border-zinc-200 px-5 py-2.5 text-sm text-zinc-700 transition-colors hover:border-zinc-300 hover:bg-zinc-50 dark:border-white/16 dark:text-white dark:hover:border-white/30 dark:hover:bg-white/5"
                >
                  View features
                </Link>
              </div>
            </div>
          </div>
        </section>

        <section className="py-20">
          <div className="mx-auto max-w-4xl px-6">
            <div className="relative">
              <div
                aria-hidden
                className="absolute top-3 bottom-3 left-3 hidden w-px bg-zinc-200 sm:block dark:bg-white/[0.08]"
              />
              <div className="space-y-8">
                {changelogEntries.map((entry) => (
                  <article
                    key={`${entry.date}-${entry.title}`}
                    className="relative sm:pl-12"
                  >
                    <span className="absolute top-2 left-0 hidden h-6 w-6 items-center justify-center rounded-full border border-zinc-200 bg-background sm:flex dark:border-white/10">
                      <span className="h-2 w-2 rounded-full bg-zinc-900 dark:bg-white" />
                    </span>
                    <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-white/[0.08] dark:bg-zinc-900/50">
                      <div className="flex flex-wrap items-center gap-3">
                        <span className="inline-flex items-center gap-1.5 text-sm text-zinc-500 dark:text-zinc-400">
                          <Tag className="size-4" />
                          {entry.tag}
                        </span>
                        <span className="inline-flex items-center gap-1.5 text-sm text-zinc-500 dark:text-zinc-400">
                          <GitCommit className="size-4" />
                          {entry.commit}
                        </span>
                        <span className="text-sm text-zinc-500 dark:text-zinc-400">
                          {entry.date}
                        </span>
                        <span
                          className={`rounded-full border px-2.5 py-1 text-xs font-medium ${categoryClassName[entry.category]}`}
                        >
                          {entry.category}
                        </span>
                      </div>
                      <h2 className="mt-4 text-2xl font-semibold tracking-tight text-zinc-950 dark:text-white">
                        {entry.title}
                      </h2>
                      <p className="mt-3 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
                        {entry.summary}
                      </p>
                      <ul className="mt-5 space-y-3">
                        {entry.items.map((item) => (
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
                  </article>
                ))}
              </div>
            </div>
          </div>
        </section>
      </main>
      <SourceWeftFooter authState={authState} />
    </div>
  );
}
