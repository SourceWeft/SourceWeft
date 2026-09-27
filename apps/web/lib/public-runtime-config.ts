import type { AnalyticsRuntimeConfig } from "./analytics/client";

export type PublicRuntimeConfig = {
  analytics: AnalyticsRuntimeConfig;
  googleMobileClientId?: string;
  apiBaseUrl: string;
  webBaseUrl: string;
  googleOneTapEnabled: boolean;
  googleOneTapClientId: string;
  googleOneTapFedCmEnabled: boolean;
};
declare global {
  interface Window {
    __SOURCEWEFT_CONFIG__?: PublicRuntimeConfig;
  }
}

// Dynamic lookup intentionally avoids Next's NEXT_PUBLIC_* build-time replacement.
const env = (name: string) => process.env[name]?.trim() ?? "";

let umamiMisconfigReported = false;

/** Umami needs both values; one without the other is a configuration error. */
export function resolveUmamiConfig(
  scriptUrl: string,
  websiteId: string,
): AnalyticsRuntimeConfig["umami"] {
  if (scriptUrl && websiteId) {
    return { scriptUrl, websiteId };
  }
  if ((scriptUrl || websiteId) && !umamiMisconfigReported) {
    umamiMisconfigReported = true;
    console.error(
      "[analytics] PUBLIC_UMAMI_SCRIPT_URL and PUBLIC_UMAMI_WEBSITE_ID must be set together; Umami is disabled.",
    );
  }
  return undefined;
}

export function serverPublicRuntimeConfig(): PublicRuntimeConfig {
  return {
    googleMobileClientId:
      env("PUBLIC_GOOGLE_MOBILE_CLIENT_ID") ||
      env("NEXT_PUBLIC_GOOGLE_MOBILE_CLIENT_ID"),
    analytics: {
      gtmId: env("PUBLIC_GTM_ID") || undefined,
      umami: resolveUmamiConfig(
        env("PUBLIC_UMAMI_SCRIPT_URL"),
        env("PUBLIC_UMAMI_WEBSITE_ID"),
      ),
    },
    apiBaseUrl:
      env("PUBLIC_API_BASE_URL") ||
      (process.env.NODE_ENV === "development"
        ? env("NEXT_PUBLIC_API_BASE_URL") || "http://localhost:3001"
        : ""),
    webBaseUrl:
      env("PUBLIC_WEB_BASE_URL") ||
      (process.env.NODE_ENV === "development"
        ? env("NEXT_PUBLIC_WEB_BASE_URL")
        : ""),
    googleOneTapEnabled:
      (env("PUBLIC_GOOGLE_ONE_TAP_ENABLED") ||
        env("NEXT_PUBLIC_GOOGLE_ONE_TAP_ENABLED")) === "true",
    googleOneTapClientId:
      env("PUBLIC_GOOGLE_ONE_TAP_CLIENT_ID") ||
      env("NEXT_PUBLIC_GOOGLE_ONE_TAP_CLIENT_ID"),
    googleOneTapFedCmEnabled:
      (env("PUBLIC_GOOGLE_ONE_TAP_FEDCM_ENABLED") ||
        env("NEXT_PUBLIC_GOOGLE_ONE_TAP_FEDCM_ENABLED")) === "true",
  };
}
export function publicRuntimeConfig(): PublicRuntimeConfig {
  return typeof window === "undefined"
    ? serverPublicRuntimeConfig()
    : (window.__SOURCEWEFT_CONFIG__ ?? {
        analytics: {},
        apiBaseUrl:
          process.env.NODE_ENV === "development"
            ? (process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001")
            : "",
        webBaseUrl: "",
        googleOneTapEnabled: false,
        googleOneTapClientId: "",
        googleOneTapFedCmEnabled: false,
      });
}
export function serializePublicConfig(config: PublicRuntimeConfig) {
  return JSON.stringify(config)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
export function publicWebBaseUrl() {
  return (
    publicRuntimeConfig().webBaseUrl.replace(/\/$/, "") ||
    (typeof window !== "undefined"
      ? window.location.origin
      : "http://localhost:3000")
  );
}
