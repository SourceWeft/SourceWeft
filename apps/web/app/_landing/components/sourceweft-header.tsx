"use client";

import Link from "next/link";
import { useEffect, useRef, type ComponentType } from "react";
import {
  ArrowUpRight,
  ChevronDown,
  History,
  Info,
  LayoutDashboard,
  Menu,
  Newspaper,
  X,
} from "lucide-react";
import { DEFAULT_LOCALE, isLocale } from "@sourceweft/i18n/locales";
import { addLocalePrefix } from "@sourceweft/i18n/resolve";
import { useLocale, useTranslations } from "next-intl";

import styles from "./navigation.module.css";
import { McpIcon, SkillIcon } from "../../_components/site-icons";
import { LanguageSwitcher } from "../../_components/language-switcher";
import { SourceWeftBrandLockup } from "./sourceweft-brand";
import { ThemeToggle } from "./theme-toggle";
import { GitHubLink } from "./github-link";
import { useCheckoutAvailable } from "../../../lib/billing-edition/capabilities";
import { type LandingAuthState } from "./use-landing-auth-state";

type NavigationItem = {
  href: string;
  label: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
};

function NavigationCard({
  item,
  onNavigate,
}: {
  item: NavigationItem;
  onNavigate: () => void;
}) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      className="group/item flex items-start gap-3.5 rounded-xl border border-transparent p-3 transition-colors hover:border-zinc-200/80 hover:bg-zinc-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500 dark:hover:border-white/10 dark:hover:bg-white/[0.04]"
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-zinc-200/80 bg-zinc-50 text-zinc-600 transition-colors group-hover/item:border-emerald-200 group-hover/item:bg-emerald-50 group-hover/item:text-emerald-700 dark:border-white/10 dark:bg-white/[0.04] dark:text-zinc-300 dark:group-hover/item:border-emerald-400/20 dark:group-hover/item:bg-emerald-400/10 dark:group-hover/item:text-emerald-300">
        <Icon className="size-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between gap-3 text-sm font-medium text-zinc-900 dark:text-zinc-100">
          {item.label}
          <ArrowUpRight
            aria-hidden
            className="size-3.5 shrink-0 text-zinc-400 opacity-0 transition-all group-hover/item:opacity-100 group-focus-visible/item:opacity-100 motion-reduce:transition-none"
          />
        </span>
        <span className="mt-1 block text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
          {item.description}
        </span>
      </span>
    </Link>
  );
}

export function SourceWeftHeader({
  authState,
  containerClassName = "max-w-6xl px-4 sm:px-6",
}: {
  authState: LandingAuthState;
  containerClassName?: string;
}) {
  const t = useTranslations("header");
  const activeLocale = useLocale();
  const checkoutAvailable = useCheckoutAvailable();
  const headerRef = useRef<HTMLElement>(null);
  const locale = isLocale(activeLocale) ? activeLocale : DEFAULT_LOCALE;
  const localized = (path: string) => addLocalePrefix(path, locale);
  const groups = [
    {
      label: t("nav.explore"),
      intro: t("navDescriptions.explore"),
      items: [
        {
          href: localized("/mcp"),
          label: t("nav.mcpServers"),
          description: t("navDescriptions.mcpServers"),
          icon: McpIcon,
        },
        {
          href: localized("/skills"),
          label: t("nav.skills"),
          description: t("navDescriptions.skills"),
          icon: SkillIcon,
        },
      ],
    },
    {
      label: t("nav.resources"),
      intro: t("navDescriptions.resources"),
      items: [
        {
          href: localized("/blog"),
          label: t("nav.blog"),
          description: t("navDescriptions.blog"),
          icon: Newspaper,
        },
        {
          href: localized("/changelog"),
          label: t("nav.changelog"),
          description: t("navDescriptions.changelog"),
          icon: History,
        },
        {
          href: localized("/about"),
          label: t("nav.about"),
          description: t("navDescriptions.about"),
          icon: Info,
        },
      ],
    },
  ];
  const directLinks = [
    { href: localized("/download"), label: t("nav.download") },
    ...(checkoutAvailable
      ? [{ href: `${localized("/")}#pricing`, label: t("nav.pricing") }]
      : []),
  ];

  function closeMenus() {
    headerRef.current
      ?.querySelectorAll("details[open]")
      .forEach((el) => el.removeAttribute("open"));
  }

  useEffect(() => {
    function outside(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Node && !headerRef.current?.contains(target))
        closeMenus();
    }
    function escape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      const open =
        headerRef.current?.querySelector<HTMLDetailsElement>("details[open]");
      if (open) {
        open.querySelector("summary")?.focus();
        closeMenus();
      }
    }
    const breakpoint = window.matchMedia("(min-width: 1024px)");
    breakpoint.addEventListener("change", closeMenus);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      breakpoint.removeEventListener("change", closeMenus);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, []);

  const navLink =
    "rounded-lg px-3 py-2 text-sm text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 focus-visible:outline-2 focus-visible:outline-offset-2 dark:text-zinc-400 dark:hover:bg-white/5 dark:hover:text-white";

  return (
    <header
      ref={headerRef}
      className="fixed inset-x-0 top-0 z-50 border-b border-zinc-200/80 bg-white/95 backdrop-blur-[12px] dark:border-white/[0.06] dark:bg-zinc-950/95"
    >
      <nav
        aria-label={t("navigation")}
        className={`mx-auto flex h-16 items-center justify-between gap-2 ${containerClassName}`}
      >
        <SourceWeftBrandLockup size="nav" />
        <div className="hidden items-center gap-1 lg:flex">
          {groups.map((group) => (
            <details
              key={group.label}
              className="group relative"
              onToggle={(event) => {
                const current = event.currentTarget;
                if (current.open)
                  headerRef.current
                    ?.querySelectorAll("details[open]")
                    .forEach((el) => {
                      if (el !== current) el.removeAttribute("open");
                    });
              }}
            >
              <summary
                className={`${navLink} flex cursor-pointer list-none items-center gap-1.5 [&::-webkit-details-marker]:hidden`}
              >
                {group.label}
                <ChevronDown
                  aria-hidden
                  className="size-3.5 transition-transform group-open:rotate-180 motion-reduce:transition-none"
                />
              </summary>
              <div
                className={`${styles.panel} absolute left-1/2 top-full w-[380px] -translate-x-1/2 pt-3`}
              >
                <div className="overflow-hidden rounded-2xl border border-zinc-200/80 bg-white p-2 shadow-[0_20px_60px_-16px_rgba(0,0,0,0.22)] ring-1 ring-black/[0.02] dark:border-white/10 dark:bg-zinc-950 dark:shadow-[0_24px_70px_-16px_rgba(0,0,0,0.65)] dark:ring-white/[0.03]">
                  <div className="mx-3 mb-2 border-b border-zinc-100 pb-4 pt-3 dark:border-white/[0.08]">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-400">
                      {group.label}
                    </p>
                    <p className="mt-1.5 text-sm text-zinc-600 dark:text-zinc-300">
                      {group.intro}
                    </p>
                  </div>
                  <div className="space-y-1">
                    {group.items.map((item) => (
                      <NavigationCard
                        key={item.href}
                        item={item}
                        onNavigate={closeMenus}
                      />
                    ))}
                  </div>
                </div>
              </div>
            </details>
          ))}
          {directLinks.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onClick={closeMenus}
              className={navLink}
            >
              {item.label}
            </Link>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-1 lg:gap-2">
          <div className="hidden items-center gap-1 lg:flex">
            <GitHubLink iconOnly />
            <LanguageSwitcher />
            <ThemeToggle />
          </div>
          {!authState.isPending && !authState.isSignedIn && (
            <Link href="/auth/sign-in" className={`${navLink} hidden lg:block`}>
              {t("signIn")}
            </Link>
          )}
          <Link
            href={authState.isSignedIn ? "/dashboard" : "/auth/sign-in"}
            onClick={closeMenus}
            aria-label={authState.isSignedIn ? t("openDashboard") : undefined}
            className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg bg-zinc-900 px-3 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-100"
          >
            {authState.isSignedIn ? (
              <>
                <LayoutDashboard aria-hidden className="size-4" />
                <span className="hidden sm:inline">{t("openDashboard")}</span>
              </>
            ) : (
              t("getStarted")
            )}
          </Link>
          <details className="group lg:hidden">
            <summary
              aria-label={t("menu")}
              className="flex size-9 cursor-pointer list-none items-center justify-center rounded-lg text-zinc-600 hover:bg-zinc-100 focus-visible:outline-2 dark:text-zinc-300 dark:hover:bg-white/5 [&::-webkit-details-marker]:hidden"
            >
              <Menu aria-hidden className="size-5 group-open:hidden" />
              <X aria-hidden className="hidden size-5 group-open:block" />
            </summary>
            <div className="absolute inset-x-0 top-full max-h-[calc(100dvh-4rem)] overflow-y-auto overscroll-contain border-b border-zinc-200 bg-white px-5 py-5 shadow-xl dark:border-white/10 dark:bg-zinc-950">
              <div className="grid gap-5 sm:grid-cols-2">
                {groups.map((group) => (
                  <div key={group.label}>
                    <p className="mb-1 px-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-400">
                      {group.label}
                    </p>
                    {group.items.map((item) => (
                      <NavigationCard
                        key={item.href}
                        item={item}
                        onNavigate={closeMenus}
                      />
                    ))}
                  </div>
                ))}
              </div>
              <div className="mt-4 flex flex-wrap gap-2 border-t border-zinc-100 pt-3 dark:border-white/10">
                <GitHubLink onClick={closeMenus} />
                {directLinks.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={closeMenus}
                    className={navLink}
                  >
                    {item.label}
                  </Link>
                ))}
                {!authState.isPending && !authState.isSignedIn && (
                  <Link
                    href="/auth/sign-in"
                    onClick={closeMenus}
                    className={navLink}
                  >
                    {t("signIn")}
                  </Link>
                )}
              </div>
              <div className="mt-3 flex items-center justify-between border-t border-zinc-100 pt-4 dark:border-white/10">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-zinc-500">{t("language")}</span>
                  <LanguageSwitcher align="start" side="top" />
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-zinc-500">
                    {t("appearance")}
                  </span>
                  <ThemeToggle />
                </div>
              </div>
            </div>
          </details>
        </div>
      </nav>
    </header>
  );
}
