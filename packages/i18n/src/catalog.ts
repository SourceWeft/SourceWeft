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
 * recursively; non-empty translated leaves replace matching English leaves.
 * Missing, empty or malformed values preserve English, including array entries.
 */
export function deepMergeMessages<T extends object>(
  base: T,
  override: object,
): T {
  const result: Record<string, unknown> = { ...base } as Record<
    string,
    unknown
  >;
  for (const [key, overrideValue] of Object.entries(override)) {
    const baseValue = result[key];
    if (isMessages(baseValue) && isMessages(overrideValue)) {
      result[key] = deepMergeMessages(baseValue, overrideValue);
    } else if (
      typeof overrideValue === "string" &&
      overrideValue.trim() &&
      (typeof baseValue === "string" || baseValue === undefined)
    ) {
      result[key] = overrideValue;
    } else if (Array.isArray(overrideValue) && Array.isArray(baseValue)) {
      result[key] = baseValue.map((value, index) =>
        typeof overrideValue[index] === "string" && overrideValue[index].trim()
          ? overrideValue[index]
          : value,
      );
    } else if (baseValue === undefined && isMessages(overrideValue)) {
      result[key] = deepMergeMessages({}, overrideValue);
    }
  }
  return result as T;
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
 * alignment test compares effective catalogs after filling missing translations
 * from English.
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
