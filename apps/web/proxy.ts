import {
  addLocalePrefix,
  negotiateLocale,
  normalizeToLocale,
  parseAcceptLanguage,
  stripLocalePrefix,
} from "@sourceweft/i18n/resolve";
import { DEFAULT_LOCALE, type Locale } from "@sourceweft/i18n/locales";
import { NextResponse, type NextRequest } from "next/server";

import { SW_LOCALE_COOKIE, SW_LOCALE_HEADER } from "./lib/i18n/constants";
import { isLocalizedPath } from "./lib/i18n/routes";

/**
 * Next 16 renamed Middleware to Proxy; this file must be named `proxy.ts`. It
 * resolves the locale for every page request and hands it to the render via the
 * `x-sw-locale` header, so `<html lang>` is right even for crawlers, which carry
 * no cookie (D6).
 *
 * Two behaviors, split by route (D3):
 *  - Localized marketing routes (`isLocalizedPath`, currently the landing): full
 *    prefix handling — canonicalize the default locale to no-prefix (308),
 *    honor an explicit locale cookie (307), otherwise rewrite the bare path onto
 *    the default locale segment so `app/[locale]` matches while the URL stays
 *    clean (`localePrefix: "as-needed"`, D4).
 *  - Everything else (app tree + not-yet-migrated marketing): no routing, just
 *    set the header so the layout renders the right `<html lang>`.
 *
 * Per D5 the Accept-Language header only influences the *rendered* locale of
 * routes that have no cookie; it never triggers a redirect on its own.
 *
 * Re-entry guard: Next re-runs the proxy against a `rewrite()` target internally
 * (confirmed by instrumentation — a single external request to `/` produces two
 * proxy invocations, the second on the rewritten `/en`). Without a guard, that
 * second pass sees an `/en` URL, hits the "default locale prefix → 308 to bare
 * path" branch, and the response for the *original* `/` request becomes a 308
 * to `/` itself — an infinite redirect loop once a client follows it. The header
 * we stamp on every branch is only ever set by this file, so its presence on an
 * incoming request reliably means "this is our own rewrite/next() continuation,
 * not a fresh external hit" — skip straight through without re-deciding.
 */
function withLocaleHeader(request: NextRequest, locale: Locale) {
  const headers = new Headers(request.headers);
  headers.set(SW_LOCALE_HEADER, locale);
  return NextResponse.next({ request: { headers } });
}

export function proxy(request: NextRequest) {
  const reentryLocale = request.headers.get(SW_LOCALE_HEADER);
  if (reentryLocale) {
    return NextResponse.next();
  }

  const url = request.nextUrl;
  const { locale: pathLocale, pathname: bare } = stripLocalePrefix(url.pathname);
  const cookieLocale = normalizeToLocale(
    request.cookies.get(SW_LOCALE_COOKIE)?.value,
  );

  if (isLocalizedPath(bare)) {
    // The URL already names a locale.
    if (pathLocale) {
      // The default locale is canonical without a prefix → 308 to the bare path.
      if (pathLocale === DEFAULT_LOCALE) {
        url.pathname = bare;
        return NextResponse.redirect(url, 308);
      }
      return withLocaleHeader(request, pathLocale);
    }

    // No prefix: an explicit non-default cookie sends the visitor to their locale.
    if (cookieLocale && cookieLocale !== DEFAULT_LOCALE) {
      url.pathname = addLocalePrefix(bare, cookieLocale);
      return NextResponse.redirect(url, 307);
    }

    // Otherwise render the default locale in place: rewrite onto its segment so
    // `app/[locale]` matches, but leave the address bar untouched.
    const headers = new Headers(request.headers);
    headers.set(SW_LOCALE_HEADER, DEFAULT_LOCALE);
    url.pathname = `/${DEFAULT_LOCALE}${bare === "/" ? "" : bare}`;
    return NextResponse.rewrite(url, { request: { headers } });
  }

  // App tree and not-yet-localized marketing: resolve for `<html lang>` only.
  const acceptLocale = parseAcceptLanguage(
    request.headers.get("accept-language"),
  );
  return withLocaleHeader(request, negotiateLocale([cookieLocale, acceptLocale]));
}

export const config = {
  // Skip API routes, Next internals, the OG image, the preview asset directory
  // injected by @sourceweft/preview, and any file with an extension.
  matcher: ["/((?!api|_next|og|file-viewer|.*\\.[\\w]+$).*)"],
};
