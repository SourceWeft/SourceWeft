"use client";
import { classifyAuthEvent } from "./analytics/auth-intent";
import {
  trackAuthError,
  trackDesktopHandoffStarted,
  trackLogin,
  trackSignUp,
} from "./analytics-events";
import { authClient } from "./auth-client";
import { publicRuntimeConfig } from "./public-runtime-config";

const DESKTOP_AUTH_STATE_STORAGE_KEY = "sourceweft.desktop.auth.state.v1";
const DESKTOP_AUTH_LOGIN_URL_STORAGE_KEY =
  "sourceweft.desktop.auth.login-url.v1";
const DESKTOP_AUTH_EXPIRES_AT_STORAGE_KEY =
  "sourceweft.desktop.auth.expires-at.v1";

const FALLBACK_WEB_BASE_URL = "http://localhost:3000";
const DESKTOP_PRODUCTION_WEB_BASE_URL = "https://sourceweft.com";
const DESKTOP_AUTH_STATE_TTL_MS = 10 * 60 * 1000;

function canUseStorage() {
  return typeof window !== "undefined" && Boolean(window.sessionStorage);
}

function randomState() {
  const cryptoObject = globalThis.crypto;
  if (cryptoObject?.randomUUID) {
    return cryptoObject.randomUUID();
  }

  const bytes = new Uint8Array(24);
  cryptoObject.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function stripTrailingSlash(value: string) {
  return value.replace(/\/$/, "");
}

function resolveWebBaseUrl() {
  const configured = publicRuntimeConfig().webBaseUrl;
  if (configured) {
    return stripTrailingSlash(configured);
  }

  if (typeof window !== "undefined" && window.location.origin) {
    if (window.__SOURCEWEFT_DESKTOP__?.isDesktop) {
      const origin = new URL(window.location.origin);
      if (origin.protocol === "http:" || origin.protocol === "https:") {
        return window.location.origin;
      }

      return DESKTOP_PRODUCTION_WEB_BASE_URL;
    }

    return window.location.origin;
  }

  return FALLBACK_WEB_BASE_URL;
}

function normalizePath(path: string) {
  return path.startsWith("/") ? path : `/${path}`;
}

function toSearchParams(search?: string | URLSearchParams | null) {
  if (!search) {
    return new URLSearchParams();
  }

  if (typeof search === "string") {
    return new URLSearchParams(
      search.startsWith("?") ? search.slice(1) : search,
    );
  }

  return new URLSearchParams(search);
}

export type PendingDesktopAuth = {
  expiresAt: number | null;
  loginUrl: string | null;
  state: string | null;
};

export function createDesktopAuthState() {
  return randomState();
}

export function buildDesktopAuthRedirectPath(state: string) {
  const url = new URL("/auth/desktop-complete", FALLBACK_WEB_BASE_URL);
  url.searchParams.set("state", state);
  return `${url.pathname}${url.search}`;
}

export function buildDesktopWebAuthUrl(input: {
  path: string;
  search?: string | URLSearchParams | null;
  state: string;
  webBaseUrl?: string;
}) {
  const webBaseUrl = input.webBaseUrl
    ? stripTrailingSlash(input.webBaseUrl)
    : resolveWebBaseUrl();
  const redirectPath = buildDesktopAuthRedirectPath(input.state);
  const path = normalizePath(input.path);

  // Signing in goes straight to the completion page. It shows who is signed in
  // before anything is handed to the desktop app, and sends people who are not
  // signed in to the sign-in page and back.
  if (path === "/auth/sign-in") {
    return new URL(redirectPath, webBaseUrl).toString();
  }

  const url = new URL(path, webBaseUrl);
  const searchParams = toSearchParams(input.search);
  searchParams.set("redirectTo", redirectPath);
  url.search = searchParams.toString();

  return url.toString();
}

/** Sign-in page that returns to the completion page for `state`. */
export function buildDesktopSignInPath(state: string) {
  const url = new URL("/auth/sign-in", FALLBACK_WEB_BASE_URL);
  url.searchParams.set("redirectTo", buildDesktopAuthRedirectPath(state));
  return `${url.pathname}${url.search}`;
}

export function buildDesktopCompleteDeepLink(input: {
  token: string;
  state: string;
}) {
  const url = new URL("sourceweft://auth/complete");
  url.searchParams.set("ott", input.token);
  url.searchParams.set("state", input.state);
  return url.toString();
}

export function isPendingDesktopAuthState(state: string | null) {
  if (!state) {
    return false;
  }

  return getPendingDesktopAuth().state === state;
}

export function setPendingDesktopAuth(input: {
  loginUrl: string;
  state: string;
}) {
  if (!canUseStorage()) {
    return;
  }

  window.sessionStorage.setItem(DESKTOP_AUTH_STATE_STORAGE_KEY, input.state);
  window.sessionStorage.setItem(
    DESKTOP_AUTH_LOGIN_URL_STORAGE_KEY,
    input.loginUrl,
  );
  window.sessionStorage.setItem(
    DESKTOP_AUTH_EXPIRES_AT_STORAGE_KEY,
    String(Date.now() + DESKTOP_AUTH_STATE_TTL_MS),
  );
}

export function getPendingDesktopAuth(): PendingDesktopAuth {
  if (!canUseStorage()) {
    return { expiresAt: null, loginUrl: null, state: null };
  }

  const expiresAt = Number(
    window.sessionStorage.getItem(DESKTOP_AUTH_EXPIRES_AT_STORAGE_KEY) || "",
  );
  if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt < Date.now()) {
    clearPendingDesktopAuth();
    return { expiresAt: null, loginUrl: null, state: null };
  }

  return {
    expiresAt: Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : null,
    loginUrl: window.sessionStorage.getItem(DESKTOP_AUTH_LOGIN_URL_STORAGE_KEY),
    state: window.sessionStorage.getItem(DESKTOP_AUTH_STATE_STORAGE_KEY),
  };
}

export function clearPendingDesktopAuth(expectedState?: string | null) {
  if (!canUseStorage()) {
    return;
  }

  const currentState = window.sessionStorage.getItem(
    DESKTOP_AUTH_STATE_STORAGE_KEY,
  );
  if (expectedState && currentState !== expectedState) {
    return;
  }

  window.sessionStorage.removeItem(DESKTOP_AUTH_STATE_STORAGE_KEY);
  window.sessionStorage.removeItem(DESKTOP_AUTH_LOGIN_URL_STORAGE_KEY);
  window.sessionStorage.removeItem(DESKTOP_AUTH_EXPIRES_AT_STORAGE_KEY);
}

export type DesktopAuthDeepLinkError = "missing-token" | "verification-failed";

function trackDesktopHandoffError() {
  trackAuthError({ action: "login", method: "desktop", surface: "desktop" });
}

/** Carries the server's (localized) message, if any; callers fall back to their own. */
export class DesktopHandoffError extends Error {
  constructor(message?: string) {
    super(message ?? "");
    this.name = "DesktopHandoffError";
  }
}

/**
 * Issues a one-time token for the browser's session and returns the deep link
 * that hands it to the desktop app. Call it only from an explicit action of
 * the signed-in person: opening a link must never be enough to issue a token.
 */
export async function createDesktopHandoffLink(state: string) {
  const result = await authClient.oneTimeToken.generate();
  const token = result.data?.token;
  if (result.error || !token) {
    trackDesktopHandoffError();
    throw new DesktopHandoffError(result.error?.message);
  }

  trackDesktopHandoffStarted();
  return buildDesktopCompleteDeepLink({ state, token });
}

/** Leaves the page for the desktop app; the browser asks before opening it. */
export function openDesktopDeepLink(deepLink: string) {
  window.location.href = deepLink;
}

/**
 * Finishes a desktop sign-in from a `sourceweft://auth/complete` deep link.
 * Returns false for any other URL, so callers can let it through.
 *
 * The deep link is the only way the browser hands the one-time token back,
 * and the token is redeemed only for the sign-in this app started: a link
 * whose state does not match the pending sign-in is dropped, whatever it
 * carries. This is also where the handoff is reported, because only the app
 * knows whether the token arrived.
 */
export async function handleDesktopAuthDeepLink(input: {
  url: string;
  onSuccess?: () => void;
  onError?: (error: DesktopAuthDeepLinkError) => void;
}) {
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    return false;
  }

  if (
    parsed.protocol !== "sourceweft:" ||
    parsed.hostname !== "auth" ||
    parsed.pathname !== "/complete"
  ) {
    return false;
  }

  const state = parsed.searchParams.get("state");
  if (!state || !isPendingDesktopAuthState(state)) {
    return true;
  }

  const token = parsed.searchParams.get("ott");
  if (!token) {
    trackDesktopHandoffError();
    input.onError?.("missing-token");
    return true;
  }

  const result = await authClient.oneTimeToken.verify({ token });
  if (result.error || !result.data) {
    // Keep the pending sign-in: the browser page can hand over a fresh token.
    trackDesktopHandoffError();
    input.onError?.("verification-failed");
    return true;
  }

  clearPendingDesktopAuth(state);
  if (classifyAuthEvent(result.data.user?.createdAt) === "sign_up") {
    trackSignUp("desktop");
  } else {
    trackLogin("desktop");
  }
  input.onSuccess?.();
  return true;
}
