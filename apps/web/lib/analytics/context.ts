import { detectNativeHostKind, nativeBridge } from "../native-bridge";

export type AnalyticsPlatform = "web" | "desktop_app" | "mobile_app";

export type AnalyticsContext = {
  platform: AnalyticsPlatform;
  app_version?: string;
};

// `detectNativeHostKind` bounds its own native calls; `nativeBridge.info()`
// does not, and every queued event waits on this context.
const APP_INFO_TIMEOUT_MS = 1000;

async function appVersion(): Promise<string | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), APP_INFO_TIMEOUT_MS);
  });
  try {
    const info = await Promise.race([nativeBridge.info(), timeout]);
    return info?.appVersion || undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** Which host the web app runs in. Never rejects. */
export async function resolveAnalyticsContext(): Promise<AnalyticsContext> {
  let kind: Awaited<ReturnType<typeof detectNativeHostKind>> = null;
  try {
    kind = await detectNativeHostKind();
  } catch {
    kind = null;
  }
  if (kind === null) {
    return { platform: "web" };
  }

  const platform = kind === "mobile" ? "mobile_app" : "desktop_app";
  const version = await appVersion();
  return version ? { platform, app_version: version } : { platform };
}
