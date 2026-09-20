/**
 * The message-catalog contract shared across owners. It deliberately holds no
 * copy — apps/web owns its strings, enterprise/billing owns the pricing strings
 * (D8) — only the shape and the merge/fallback rules the assembly point relies
 * on (§6.1). next-intl does per-key lookup at render time; this module is the
 * server-side plumbing that composes and back-fills catalogs before that.
 */

import { DEFAULT_LOCALE, type Locale } from "./locales";

/** A namespaced, arbitrarily nested tree of ICU message strings. */
export type Messages = { [key: string]: string | Messages };

function isMessages(value: unknown): value is Messages {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deep-merge `override` onto `base`, returning a new object. Used at the one
 * assembly point that folds `enterprise/billing/messages` into the web catalog's
 * `pricing` namespace without mutating either input. Object nodes merge
 * recursively; a string (leaf) in `override` replaces the base value.
 */
export function deepMergeMessages(base: Messages, override: Messages): Messages {
  const result: Messages = { ...base };
  for (const [key, overrideValue] of Object.entries(override)) {
    const baseValue = result[key];
    if (isMessages(baseValue) && isMessages(overrideValue)) {
      result[key] = deepMergeMessages(baseValue, overrideValue);
    } else {
      result[key] = overrideValue;
    }
  }
  return result;
}

/**
 * The lookup order for a locale's messages: the locale itself, then the default
 * locale as a backstop, deduped. next-intl uses this so a key missing from a
 * translation renders the English string instead of the raw key.
 */
export function getFallbackChain(locale: Locale): Locale[] {
  return locale === DEFAULT_LOCALE ? [locale] : [locale, DEFAULT_LOCALE];
}

/**
 * Flatten a nested catalog to dotted keys (`landing.hero.headline`). The catalog
 * alignment test (§14.1) compares these key sets across locales, so a missing or
 * extra key in any translation fails CI.
 */
export function flattenKeys(messages: Messages, prefix = ""): string[] {
  const keys: string[] = [];
  for (const [key, value] of Object.entries(messages)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isMessages(value)) {
      keys.push(...flattenKeys(value, path));
    } else {
      keys.push(path);
    }
  }
  return keys.sort();
}
