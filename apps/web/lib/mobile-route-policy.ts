"use client";

export type MobileRouteAction =
  | { type: "allow" }
  | { type: "sheet"; title: string; url: URL }
  | { type: "external"; url: URL }
  | { type: "ignore" };

export type MobileRouteIntent = {
  href: string | null;
  currentUrl: string;
  altKey?: boolean;
  button?: number;
  ctrlKey?: boolean;
  download?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
};

const allowedAuthPaths = new Set([
  "/auth/sign-in",
  "/auth/sign-up",
  "/auth/callback",
  "/auth/sign-out",
  "/auth/accept-invitation",
  "/auth/consent",
  "/auth/desktop-complete",
  "/auth/error",
]);

export function isPrimaryMobileRoute(pathname: string) {
  return (
    pathname === "/dashboard" ||
    pathname.startsWith("/dashboard/") ||
    allowedAuthPaths.has(pathname)
  );
}

function isHashOnlyNavigation(url: URL, currentUrl: URL) {
  return (
    url.origin === currentUrl.origin &&
    url.pathname === currentUrl.pathname &&
    url.search === currentUrl.search &&
    url.hash !== currentUrl.hash &&
    url.hash.length > 0
  );
}

function isModifiedClick(intent: MobileRouteIntent) {
  return Boolean(
    intent.altKey ||
      intent.ctrlKey ||
      intent.metaKey ||
      intent.shiftKey ||
      (typeof intent.button === "number" && intent.button !== 0),
  );
}

function isWebUrl(url: URL) {
  return url.protocol === "http:" || url.protocol === "https:";
}

function sheetTitleForPath(pathname: string) {
  if (pathname === "/terms") {
    return "Terms";
  }

  if (pathname === "/privacy") {
    return "Privacy Policy";
  }

  if (pathname === "/notifications" || pathname.startsWith("/notifications/")) {
    return "Notifications";
  }

  if (pathname === "/blog" || pathname.startsWith("/blog/")) {
    return "Blog";
  }

  const segment = pathname.split("/").filter(Boolean).at(0);
  if (!segment) {
    return "SourceWeft";
  }

  return segment
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function getMobileSheetTitle(pathname: string) {
  return sheetTitleForPath(pathname);
}

export function resolveMobileRouteAction(
  intent: MobileRouteIntent,
): MobileRouteAction {
  if (!intent.href || intent.download || isModifiedClick(intent)) {
    return { type: "ignore" };
  }

  let currentUrl: URL;
  let url: URL;
  try {
    currentUrl = new URL(intent.currentUrl);
    url = new URL(intent.href, currentUrl);
  } catch {
    return { type: "ignore" };
  }

  if (isHashOnlyNavigation(url, currentUrl)) {
    return { type: "ignore" };
  }

  if (!isWebUrl(url)) {
    return { type: "ignore" };
  }

  if (url.origin !== currentUrl.origin) {
    return { type: "external", url };
  }

  if (isPrimaryMobileRoute(url.pathname)) {
    return { type: "allow" };
  }

  return {
    type: "sheet",
    title: sheetTitleForPath(url.pathname),
    url,
  };
}
