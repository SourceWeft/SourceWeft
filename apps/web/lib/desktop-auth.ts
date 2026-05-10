"use client";

const DESKTOP_AUTH_STATE_STORAGE_KEY = "sourceweft.desktop.auth.state.v1";
const DESKTOP_AUTH_LOGIN_URL_STORAGE_KEY = "sourceweft.desktop.auth.login-url.v1";
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
  const configured = process.env.NEXT_PUBLIC_WEB_BASE_URL?.trim();
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
    return new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
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
  const url = new URL(
    normalizePath(input.path),
    input.webBaseUrl ? stripTrailingSlash(input.webBaseUrl) : resolveWebBaseUrl(),
  );
  const searchParams = toSearchParams(input.search);

  searchParams.delete("desktop");
  searchParams.delete("redirectTo");
  searchParams.set("desktop", "1");
  searchParams.set("redirectTo", buildDesktopAuthRedirectPath(input.state));
  url.search = searchParams.toString();

  return url.toString();
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
  window.sessionStorage.setItem(DESKTOP_AUTH_LOGIN_URL_STORAGE_KEY, input.loginUrl);
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
