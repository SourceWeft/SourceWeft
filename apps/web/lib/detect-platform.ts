export type DetectedPlatform =
  "macos" | "windows" | "linux" | "ios" | "android" | "mobile" | "unknown";

export type PlatformNavigator = {
  userAgent?: string;
  platform?: string;
  maxTouchPoints?: number;
  userAgentData?: { platform?: string; mobile?: boolean };
};

export function isMobilePlatform(platform: DetectedPlatform) {
  return platform === "ios" || platform === "android" || platform === "mobile";
}

/** Coarse OS detection for choosing the primary download button. Architecture
 * is intentionally not detected: browsers do not expose it reliably. */
export function detectPlatform(
  navigator: PlatformNavigator | undefined,
): DetectedPlatform {
  if (!navigator) return "unknown";
  const hinted = navigator.userAgentData?.platform?.toLowerCase() ?? "";
  if (hinted === "android") return "android";
  if (hinted === "ios") return "ios";
  if (navigator.userAgentData?.mobile) return "mobile";
  if (hinted === "macos") return "macos";
  if (hinted === "windows") return "windows";
  if (hinted === "linux" || hinted === "chrome os") return "linux";

  const ua = navigator.userAgent?.toLowerCase() ?? "";
  const platform = navigator.platform?.toLowerCase() ?? "";
  if (/iphone|ipod|ipad/.test(ua)) return "ios";
  // iPadOS Safari reports itself as a Mac; touch support is the tell.
  if (platform.startsWith("mac") && (navigator.maxTouchPoints ?? 0) > 1) {
    return "ios";
  }
  if (/android/.test(ua)) return "android";
  if (/mobile/.test(ua)) return "mobile";
  if (platform.startsWith("mac") || /macintosh|mac os x/.test(ua)) {
    return "macos";
  }
  if (platform.startsWith("win") || /windows/.test(ua)) return "windows";
  if (platform.includes("linux") || /linux|cros/.test(ua)) return "linux";
  return "unknown";
}
