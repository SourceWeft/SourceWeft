"use client";

import {
  DEFAULT_LOCALE,
  getLocaleMeta,
  isLocale,
  LOCALES,
  type Locale,
} from "@sourceweft/i18n/locales";
import { addLocalePrefix, stripLocalePrefix } from "@sourceweft/i18n/resolve";
import { useLocale, useTranslations } from "next-intl";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { setLocaleCookie } from "../../lib/i18n/cookie";
import { isLocalizedPath } from "../../lib/i18n/routes";
import { authClient } from "../../lib/auth-client";
import { userSettingsClient } from "../../lib/sdk";

function IconGlobe() {
  return (
    <svg
      className="h-4 w-4"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <circle cx="12" cy="12" r="9" />
      <path
        strokeLinecap="round"
        d="M3 12h18M12 3c2.5 2.5 3.5 5.8 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.8-3.5-9s1-6.5 3.5-9Z"
      />
    </svg>
  );
}

export function LanguageSwitcher() {
  const t = useTranslations("languageSwitcher");
  const activeLocale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  // A signed-in user can reach this switcher too (it's on marketing pages
  // like /blog, not just the logged-out landing page). Their choice must
  // follow them across devices the same way the dashboard's own language
  // selector does — a cookie alone is per-browser and would silently
  // contradict the account setting on their next device.
  const { data: session } = authClient.useSession();
  const userId = session?.user?.id;

  useEffect(() => {
    if (!open) {
      return;
    }
    function onPointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function selectLocale(next: Locale) {
    setOpen(false);
    if (next === activeLocale) {
      return;
    }
    // Persist the explicit choice so the proxy honors it on later requests (§5).
    setLocaleCookie(next);
    if (userId) {
      // Signed in: also persist to the account (mirrors account-panel.tsx's
      // language selector) so the choice is the same "one long-term truth"
      // on every device, not a per-browser fork of it. Best-effort — the
      // cookie already applied, so a failed write only costs a future
      // device's first-load guess, not this session's UI.
      void userSettingsClient
        .updateSettings({ appearance: { language: next } })
        .catch(() => {});
    }

    // On a localized route, swap the URL's locale prefix; elsewhere the cookie is
    // enough and a refresh re-renders the chrome in the new language.
    //
    // `router.push` alone is not enough here: `/` and `/zh-CN` share the same
    // root layout, and the App Router only re-renders segments that differ
    // between the old and new URL trees — so `NextIntlClientProvider` (mounted
    // in the root layout, above the `[locale]` segment) keeps serving the
    // previous locale's messages even after the URL/title update. `refresh()`
    // forces Next to invalidate and re-fetch the whole tree for the new path,
    // including that shared root layout, so the chrome actually re-renders in
    // the new language instead of only the leaf segment's metadata changing.
    const { pathname: bare } = stripLocalePrefix(pathname ?? "/");
    if (isLocalizedPath(bare)) {
      router.push(
        `${addLocalePrefix(bare, next)}${window.location.search}${window.location.hash}`,
      );
      router.refresh();
    } else {
      router.refresh();
    }
  }

  const activeMeta = isLocale(activeLocale)
    ? getLocaleMeta(activeLocale)
    : getLocaleMeta(DEFAULT_LOCALE);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-label={t("ariaLabel")}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-white"
      >
        <IconGlobe />
        <span className="hidden text-sm sm:inline">
          {activeMeta.nativeLabel}
        </span>
      </button>

      {open ? (
        <ul
          role="listbox"
          aria-label={t("label")}
          className="absolute right-0 top-full z-50 mt-1 min-w-36 overflow-hidden rounded-lg border border-zinc-200 bg-white py-1 shadow-lg dark:border-white/10 dark:bg-zinc-900"
        >
          {LOCALES.map((meta) => {
            const isActive = isLocale(activeLocale) && meta.id === activeLocale;
            return (
              <li key={meta.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  lang={meta.htmlLang}
                  onClick={() => selectLocale(meta.id)}
                  className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-sm transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800 ${
                    isActive
                      ? "font-medium text-zinc-900 dark:text-white"
                      : "text-zinc-600 dark:text-zinc-300"
                  }`}
                >
                  {meta.nativeLabel}
                  {isActive ? <span aria-hidden>✓</span> : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
