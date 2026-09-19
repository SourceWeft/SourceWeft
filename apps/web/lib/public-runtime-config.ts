export type PublicRuntimeConfig = {
  googleMobileClientId?: string;
  gtmId?: string;
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
export function serverPublicRuntimeConfig(): PublicRuntimeConfig {
  return {
    googleMobileClientId:
      env("PUBLIC_GOOGLE_MOBILE_CLIENT_ID") ||
      env("NEXT_PUBLIC_GOOGLE_MOBILE_CLIENT_ID"),
    gtmId: env("PUBLIC_GTM_ID"),
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
