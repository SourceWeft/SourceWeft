"use client";
import { useMemo } from "react";
import {
  formatCurrency,
  formatDate,
  formatNumber,
  isLocale,
  type Locale,
} from "@sourceweft/i18n";

import { formatCopy, getBillingCopy, type BillingCopy } from "../messages";
import { useBillingLocale } from "./context";

export type BillingCopyFormat = {
  /** Whole-number formatting, e.g. seat/credit/page counts. */
  number(value: number): string;
  /** `iso` is a `Date`-parseable timestamp, such as `entry.createdAt`. */
  date(iso: string): string;
  /** `cents` matches the ledger/order convention of USD minor units. */
  currency(cents: number, currency?: string): string;
};

/**
 * The billing UI's localized copy plus locale-aware number/date/currency
 * formatting, built on `@sourceweft/i18n`. Every `Intl.*` construction goes
 * through that package (never a literal locale here), matching the rest of
 * the product (design D9/§7 in `packages/i18n`).
 *
 * `copy` fills every missing key from English (`getBillingCopy`); templated
 * strings still need `formatCopy(copy.some.key, { ... })` to fill in their
 * `{name}` placeholders.
 */
export function useBillingCopy(): {
  copy: BillingCopy;
  locale: string;
  format: BillingCopyFormat;
} {
  const locale = useBillingLocale();

  return useMemo(() => {
    const intlLocale: Locale = isLocale(locale) ? locale : "en";

    return {
      copy: getBillingCopy(locale),
      locale,
      format: {
        number: (value) =>
          formatNumber(value, intlLocale, { maximumFractionDigits: 0 }),
        date: (iso) =>
          formatDate(new Date(iso), intlLocale, {
            year: "numeric",
            month: "short",
            day: "2-digit",
          }),
        currency: (cents, currency = "USD") =>
          formatCurrency(cents / 100, intlLocale, currency),
      },
    };
  }, [locale]);
}

export { formatCopy };
