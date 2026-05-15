"use client";

import { useAuthenticate } from "@daveyplate/better-auth-ui";
import { Github } from "lucide-react";
import Link from "next/link";

import { SourceWeftBrandLockup } from "./sourceweft-brand";
import { ThemeToggle } from "./theme-toggle";

export const SOURCEWEFT_GITHUB_URL =
  "https://github.com/SourceWeft/SourceWeft";

export function SourceWeftHeader() {
  const authState = useAuthenticate({ enabled: false });
  const isLoggedIn = Boolean(authState.data);

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
          <a
            href={SOURCEWEFT_GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            aria-label="View SourceWeft on GitHub"
            className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-white"
          >
            <Github className="h-4 w-4" />
            <span className="hidden sm:inline">GitHub</span>
          </a>
          <ThemeToggle />
          {isLoggedIn ? (
            <Link
              href="/dashboard"
              className="text-sm font-medium text-zinc-500 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white"
            >
              Go to dashboard →
            </Link>
          ) : (
            <>
              <Link
                href="/auth/sign-in"
                className="hidden text-sm text-zinc-500 transition-colors hover:text-zinc-900 sm:block dark:text-zinc-400 dark:hover:text-white"
              >
                Sign in
              </Link>
              <Link
                href="/auth/sign-up"
                className="rounded-lg bg-zinc-900 px-3.5 py-1.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-100"
              >
                Get Started
              </Link>
            </>
          )}
        </div>
      </nav>
    </header>
  );
}
