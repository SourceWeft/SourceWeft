"use client";

import Link from "next/link";
import { LayoutDashboard } from "lucide-react";
import { DEFAULT_LOCALE, isLocale } from "@sourceweft/i18n/locales";
import { addLocalePrefix } from "@sourceweft/i18n/resolve";
import { useLocale, useTranslations } from "next-intl";

import { LanguageSwitcher } from "../../_components/language-switcher";
import { SourceWeftBrandLockup } from "./sourceweft-brand";
import { ThemeToggle } from "./theme-toggle";
import { useCheckoutAvailable } from "../../../lib/billing-edition/capabilities";
import {
  getLandingUserLabel,
  type LandingAuthState,
} from "./use-landing-auth-state";

export function SourceWeftHeader({
  authState,
  containerClassName = "max-w-6xl px-6",
}: {
  authState: LandingAuthState;
  containerClassName?: string;
}) {
  const t = useTranslations("header");
  const activeLocale = useLocale();
  const dashboardHref = "/dashboard";
  const checkoutAvailable = useCheckoutAvailable();
  const signInHref = "/auth/sign-in";
  const userLabel = getLandingUserLabel(authState.user);

  // Landing anchors keep the visitor in their locale; the marketing routes that
  // are not yet localized (/mcp, /blog) stay prefix-free until they are migrated.
  const localePrefix = isLocale(activeLocale) ? activeLocale : DEFAULT_LOCALE;
  const landingBase = addLocalePrefix("/", localePrefix);
  const navItems = [
    { href: `${landingBase}#features`, label: t("nav.features"), gated: false },
    {
      href: `${landingBase}#how-it-works`,
      label: t("nav.howItWorks"),
      gated: false,
    },
    { href: `${landingBase}#pricing`, label: t("nav.pricing"), gated: true },
    { href: addLocalePrefix("/mcp", localePrefix), label: t("nav.mcpServers"), gated: false },
    // Not migrated into the locale-prefixed marketing tree yet — new since
    // this i18n work started; stays a plain path like an un-migrated route.
    { href: "/download", label: t("nav.download"), gated: false },
    { href: addLocalePrefix("/blog", localePrefix), label: t("nav.blog"), gated: false },
  ];

  return (
    <header className="fixed inset-x-0 top-0 z-50 border-b border-zinc-200/80 bg-white/85 backdrop-blur-[12px] dark:border-white/[0.06] dark:bg-zinc-950/85">
      <nav
        className={`mx-auto flex h-14 items-center justify-between ${containerClassName}`}
      >
        <SourceWeftBrandLockup size="nav" />

        <div className="hidden items-center gap-6 md:flex">
          {navItems
            .filter((item) => !item.gated || checkoutAvailable)
            .map((item) => (
              <a
                key={item.href}
                href={item.href}
                className="text-sm text-zinc-500 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white"
              >
                {item.label}
              </a>
            ))}
        </div>

        <div className="flex items-center gap-3">
          <LanguageSwitcher />
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
              {t("signIn")}
            </Link>
          )}
          {authState.isSignedIn ? (
            <Link
              href={dashboardHref}
              className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:border-zinc-300 hover:bg-zinc-50 hover:text-zinc-950 dark:border-white/12 dark:text-zinc-200 dark:hover:border-white/24 dark:hover:bg-white/5 dark:hover:text-white"
            >
              <LayoutDashboard className="size-3.5" />
              {t("openDashboard")}
            </Link>
          ) : (
            <Link
              href={signInHref}
              className="rounded-lg bg-zinc-900 px-3.5 py-1.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-100"
            >
              {t("getStarted")}
            </Link>
          )}
        </div>
      </nav>
    </header>
  );
}
