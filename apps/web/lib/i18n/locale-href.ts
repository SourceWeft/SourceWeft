import { DEFAULT_LOCALE, isLocale } from "@sourceweft/i18n/locales";
import { addLocalePrefix, stripLocalePrefix } from "@sourceweft/i18n/resolve";

import { isLocalizedPath } from "./routes";

/**
 * `href` as seen from a page rendered in `locale`: a link into the localized
 * marketing tree keeps the reader's language (`/skills/x` → `/zh-CN/skills/x`),
 * so a visitor who arrived on a prefixed URL — no locale cookie, e.g. from a
 * search result — and crawlers stay in that language. Everything else (the app
 * tree, auth, external URLs, anchors) is returned untouched.
 */
export function localeHref(href: string, locale: string): string {
  if (!href.startsWith("/") || href.startsWith("//")) {
    return href;
  }
  const target = isLocale(locale) ? locale : DEFAULT_LOCALE;
  const split = href.search(/[?#]/);
  const path = split === -1 ? href : href.slice(0, split);
  const rest = split === -1 ? "" : href.slice(split);
  if (!isLocalizedPath(stripLocalePrefix(path).pathname)) {
    return href;
  }
  return `${addLocalePrefix(path, target)}${rest}`;
}
