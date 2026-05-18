"use client";

import { SourceWeftFooter } from "../components/sourceweft-footer";
import { SourceWeftHeader } from "../components/sourceweft-header";
import { useLandingAuthState } from "../components/use-landing-auth-state";

type LegalSection = {
  title: string;
  body: string[];
  items?: string[];
};

type LegalPageProps = {
  title: string;
  description: string;
  sections: LegalSection[];
};

const LAST_UPDATED = "May 15, 2026";
export function LegalPage({ title, description, sections }: LegalPageProps) {
  const authState = useLandingAuthState();

  return (
    <div className="min-h-screen bg-background text-foreground">
      <SourceWeftHeader authState={authState} />
      <main>
        <div className="mx-auto flex max-w-4xl flex-col px-6 pt-28 pb-14 sm:pt-32 sm:pb-18">
          <header className="border-b border-zinc-200 pb-8 dark:border-white/[0.08]">
            <p className="text-xs font-medium uppercase tracking-widest text-zinc-400 dark:text-zinc-600">
              Last updated: {LAST_UPDATED}
            </p>
            <h1 className="mt-4 text-4xl font-bold tracking-tight text-zinc-950 sm:text-5xl dark:text-white">
              {title}
            </h1>
            <p className="mt-5 max-w-2xl text-base leading-7 text-zinc-600 dark:text-zinc-400">
              {description}
            </p>
          </header>

          <div className="divide-y divide-zinc-200 dark:divide-white/[0.08]">
            {sections.map((section, index) => (
              <section key={section.title} className="py-8">
                <h2 className="text-xl font-semibold tracking-tight text-zinc-950 dark:text-white">
                  {index + 1}. {section.title}
                </h2>
                <div className="mt-4 space-y-4 text-sm leading-7 text-zinc-600 dark:text-zinc-400">
                  {section.body.map((paragraph) => (
                    <p key={paragraph}>{paragraph}</p>
                  ))}
                  {section.items ? (
                    <ul className="list-disc space-y-2 pl-5">
                      {section.items.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </section>
            ))}
          </div>
        </div>
      </main>
      <SourceWeftFooter authState={authState} />
    </div>
  );
}
