import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE_NAME,
  normalizeLocale,
  resolveLocaleFromAcceptLanguage,
} from "./lib/locale";

const LOCALE_HEADER_NAME = "x-sourceweft-locale";
const LOCALE_QUERY_PARAM = "lang";
const LOCALE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export function middleware(request: NextRequest) {
  const queryLocale = normalizeLocale(
    request.nextUrl.searchParams.get(LOCALE_QUERY_PARAM),
  );
  const [firstPathSegment = ""] = request.nextUrl.pathname
    .split("/")
    .filter(Boolean);
  const pathLocale = normalizeLocale(firstPathSegment);
  const cookieLocale = normalizeLocale(
    request.cookies.get(LOCALE_COOKIE_NAME)?.value,
  );
  const acceptLanguageLocale = resolveLocaleFromAcceptLanguage(
    request.headers.get("accept-language"),
  );

  const locale =
    queryLocale ??
    pathLocale ??
    cookieLocale ??
    acceptLanguageLocale ??
    DEFAULT_LOCALE;

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(LOCALE_HEADER_NAME, locale);

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });

  if (cookieLocale !== locale || queryLocale) {
    response.cookies.set({
      maxAge: LOCALE_COOKIE_MAX_AGE_SECONDS,
      name: LOCALE_COOKIE_NAME,
      path: "/",
      sameSite: "lax",
      secure: request.nextUrl.protocol === "https:",
      value: locale,
    });
  }

  return response;
}

export const config = {
  matcher: [
    "/((?!api|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\..*).*)",
  ],
};
