"use client";

import Link from "next/link";

import { SourceWeftBrandLockup } from "./sourceweft-brand";
import type { LandingAuthState } from "./use-landing-auth-state";

const COMPANY_LINKS = [
  ["/about", "About"],
  ["/changelog", "Changelog"],
] as const;

const LEGAL_LINKS = [
  ["/privacy", "Privacy"],
  ["/terms", "Terms"],
] as const;

function FooterColumn({
  title,
  links,
}: {
  title: string;
  links: readonly (readonly [string, string])[];
}) {
  return (
    <div>
      <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-600">
        {title}
      </p>
      <ul className="space-y-2 text-sm">
        {links.map(([href, label]) => (
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
  );
}

export function SourceWeftFooter({
  authState,
}: {
  authState?: LandingAuthState;
}) {
  const productLinks = [
    ["/#features", "Features"],
    ["/#how-it-works", "How it works"],
    ["/#pricing", "Pricing"],
    [
      authState?.isSignedIn ? "/dashboard" : "/auth/sign-in",
      authState?.isSignedIn ? "Dashboard" : "Get started",
    ],
  ] as const;

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

          <FooterColumn title="Product" links={productLinks} />
          <FooterColumn title="Company" links={COMPANY_LINKS} />
          <FooterColumn title="Legal" links={LEGAL_LINKS} />
        </div>

        <div className="mt-10 flex flex-wrap items-center justify-between gap-4 border-t border-zinc-100 pt-8 text-xs text-zinc-400 dark:border-white/[0.06] dark:text-zinc-700">
          <p>© {new Date().getFullYear()} SourceWeft. All rights reserved.</p>
          <span>Build By SourceWeft</span>
        </div>
      </div>
    </footer>
  );
}
