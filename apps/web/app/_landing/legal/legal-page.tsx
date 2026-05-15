import Link from "next/link";

import { SourceWeftBrandLockup } from "../components/sourceweft-brand";
import { SourceWeftHeader } from "../components/sourceweft-header";

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
const PRODUCT_LINKS = [
  ["/#features", "Features"],
  ["/#how-it-works", "How it works"],
  ["/#pricing", "Pricing"],
  ["/auth/sign-up", "Get started"],
] as const;
const LEGAL_LINKS = [
  ["/privacy", "Privacy"],
  ["/terms", "Terms"],
] as const;

function LegalFooter() {
  return (
    <footer className="border-t border-zinc-200 py-12 dark:border-white/[0.06]">
      <div className="mx-auto max-w-6xl px-6">
        <div className="grid gap-8 sm:grid-cols-2 md:grid-cols-4">
          <div>
            <SourceWeftBrandLockup size="footer" />
            <p className="mt-3 text-xs leading-relaxed text-zinc-400 dark:text-zinc-600">
              Your AI notebook workspace. Connect everything. Think deeper.
            </p>
          </div>

          <div>
            <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-600">
              Product
            </p>
            <ul className="space-y-2 text-sm">
              {PRODUCT_LINKS.map(([href, label]) => (
                <li key={href}>
                  <Link
                    href={href}
                    className="text-zinc-400 transition-colors hover:text-zinc-900 dark:text-zinc-500 dark:hover:text-white"
                  >
                    {label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-600">
              Company
            </p>
            <ul className="space-y-2 text-sm">
              {["About", "Blog", "Changelog"].map((label) => (
                <li key={label}>
                  <span className="text-zinc-400 dark:text-zinc-500">
                    {label}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-600">
              Legal
            </p>
            <ul className="space-y-2 text-sm">
              {LEGAL_LINKS.map(([href, label]) => (
                <li key={href}>
                  <Link
                    href={href}
                    target="_blank"
                    rel="noreferrer"
                    className="text-zinc-400 transition-colors hover:text-zinc-900 dark:text-zinc-500 dark:hover:text-white"
                  >
                    {label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="mt-10 flex flex-wrap items-center justify-between gap-4 border-t border-zinc-100 pt-8 text-xs text-zinc-400 dark:border-white/[0.06] dark:text-zinc-700">
          <p>© {new Date().getFullYear()} SourceWeft. All rights reserved.</p>
          <span>Build By SourceWeft</span>
        </div>
      </div>
    </footer>
  );
}

export function LegalPage({ title, description, sections }: LegalPageProps) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <SourceWeftHeader />
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
      <LegalFooter />
    </div>
  );
}
