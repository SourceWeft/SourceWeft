"use client";

import Link from "next/link";
import { LayoutDashboard } from "lucide-react";

import { SourceWeftBrandLockup } from "./sourceweft-brand";
import { ThemeToggle } from "./theme-toggle";
import {
  getLandingUserLabel,
  type LandingAuthState,
} from "./use-landing-auth-state";

export function SourceWeftHeader({ authState }: { authState: LandingAuthState }) {
  const dashboardHref = "/dashboard";
  const signInHref = "/auth/sign-in";
  const userLabel = getLandingUserLabel(authState.user);

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
              ["/blog", "Blog"],
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
          {authState.isPending ? (
            <span className="hidden h-4 w-20 rounded bg-zinc-200/70 sm:block dark:bg-white/10" />
          ) : authState.isSignedIn ? (
            <span className="hidden max-w-36 truncate text-sm text-zinc-500 sm:block dark:text-zinc-400">
              {userLabel}
            </span>
          ) : (
            <Link
              href={signInHref}
              className="hidden text-sm text-zinc-500 transition-colors hover:text-zinc-900 sm:block dark:text-zinc-400 dark:hover:text-white"
            >
              Sign in
            </Link>
          )}
          {authState.isSignedIn ? (
            <Link
              href={dashboardHref}
              className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:border-zinc-300 hover:bg-zinc-50 hover:text-zinc-950 dark:border-white/12 dark:text-zinc-200 dark:hover:border-white/24 dark:hover:bg-white/5 dark:hover:text-white"
            >
              <LayoutDashboard className="size-3.5" />
              Open Dashboard
            </Link>
          ) : (
            <Link
              href={signInHref}
              className="rounded-lg bg-zinc-900 px-3.5 py-1.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-100"
            >
              Get Started
            </Link>
          )}
        </div>
      </nav>
    </header>
  );
}
