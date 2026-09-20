"use client";

import Link from "next/link";
import { DEFAULT_LOCALE, isLocale } from "@sourceweft/i18n/locales";
import { addLocalePrefix } from "@sourceweft/i18n/resolve";
import { useLocale, useTranslations } from "next-intl";

import { useCheckoutAvailable } from "../../../lib/billing-edition/capabilities";

import { SourceWeftBrandLockup } from "./sourceweft-brand";
import type { LandingAuthState } from "./use-landing-auth-state";

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
  containerClassName = "max-w-6xl px-6",
}: {
  authState?: LandingAuthState;
  containerClassName?: string;
}) {
  const t = useTranslations("footer");
  const activeLocale = useLocale();
  const checkoutAvailable = useCheckoutAvailable();

  const localePrefix = isLocale(activeLocale) ? activeLocale : DEFAULT_LOCALE;
  const landingBase = addLocalePrefix("/", localePrefix);

  const productLinks = (
    [
      [`${landingBase}#features`, t("links.features"), false],
      [`${landingBase}#how-it-works`, t("links.howItWorks"), false],
      [`${landingBase}#pricing`, t("links.pricing"), true],
      [addLocalePrefix("/mcp", localePrefix), t("links.mcpServers"), false],
      [addLocalePrefix("/blog", localePrefix), t("links.blog"), false],
      [
        authState?.isSignedIn ? "/dashboard" : "/auth/sign-in",
        authState?.isSignedIn ? t("links.dashboard") : t("links.getStarted"),
        false,
      ],
    ] as const
  )
    .filter(([, , gated]) => !gated || checkoutAvailable)
    .map(([href, label]) => [href, label] as const);

  const companyLinks = [
    [addLocalePrefix("/about", localePrefix), t("links.about")],
    [addLocalePrefix("/changelog", localePrefix), t("links.changelog")],
  ] as const;
  const legalLinks = [
    ["/privacy", t("links.privacy")],
    ["/terms", t("links.terms")],
  ] as const;

  return (
    <footer className="border-t border-zinc-200 py-12 dark:border-white/[0.06]">
      <div className={`mx-auto ${containerClassName}`}>
        <div className="grid gap-8 sm:grid-cols-2 md:grid-cols-4">
          <div>
            <SourceWeftBrandLockup size="footer" />
            <p className="mt-3 text-xs leading-relaxed text-zinc-400 dark:text-zinc-600">
              {t("tagline")}
            </p>
          </div>

          <FooterColumn title={t("product")} links={productLinks} />
          <FooterColumn title={t("company")} links={companyLinks} />
          <FooterColumn title={t("legal")} links={legalLinks} />
        </div>

        <div className="mt-10 flex flex-wrap items-center justify-between gap-4 border-t border-zinc-100 pt-8 text-xs text-zinc-400 dark:border-white/[0.06] dark:text-zinc-700">
          <p>{t("copyright", { year: new Date().getFullYear() })}</p>
          <span>{t("builtBy")}</span>
        </div>
      </div>
    </footer>
  );
}
