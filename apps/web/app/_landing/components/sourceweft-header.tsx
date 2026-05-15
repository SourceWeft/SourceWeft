"use client";

import Link from "next/link";

import { SourceWeftBrandLockup } from "./sourceweft-brand";
import { ThemeToggle } from "./theme-toggle";

export function SourceWeftHeader() {
  return (
    <header className="fixed inset-x-0 top-0 z-50 border-b border-zinc-200/80 bg-white/85 backdrop-blur-[12px] dark:border-white/[0.06] dark:bg-zinc-950/85">
      <nav className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
        <SourceWeftBrandLockup size="nav" />

        <div className="hidden items-center gap-6 md:flex">
          {(
            [
              ["/#features", "Features"],
              ["/#how-it-works", "How it works"],
              ["/#pricing", "Pricing"],
            ] as const
          ).map(([href, label]) => (
            <a
              key={href}
              href={href}
              className="text-sm text-zinc-500 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white"
            >
              {label}
            </a>
          ))}
        </div>

        <div className="flex items-center gap-3">
          <ThemeToggle />
          <Link
            href="/auth/sign-in"
            className="hidden text-sm text-zinc-500 transition-colors hover:text-zinc-900 sm:block dark:text-zinc-400 dark:hover:text-white"
          >
            Sign in
          </Link>
          <Link
            href="/auth/sign-in"
            className="rounded-lg bg-zinc-900 px-3.5 py-1.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-100"
          >
            Get Started
          </Link>
        </div>
      </nav>
    </header>
  );
}
