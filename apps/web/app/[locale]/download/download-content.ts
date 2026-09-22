import type {
  DownloadArch,
  DownloadPlatform,
} from "../../../lib/download-channels";

// Store and marketplace listings are not release artifacts: they change once
// per listing, so they live in code and go through review. `undefined` renders
// the corresponding entry as "Coming soon".
export const STORE_LINKS: Record<
  "ios" | "android" | "chrome" | "edge",
  string | undefined
> = {
  ios: undefined,
  android: undefined,
  chrome: undefined,
  edge: undefined,
};

// `label` and `store` are platform/marketplace names, not UI copy, so they stay
// as literal identifiers here rather than moving into the `download` message
// catalog. The description ("devices") and CTA text ("storeAction") are UI
// copy and live in messages under `mobile.<id>.devices` / `mobile.<id>.storeAction`.
export type MobilePlatformDisplay = {
  id: "ios" | "android";
  label: string;
  store: string;
};

export const MOBILE_PLATFORMS: readonly MobilePlatformDisplay[] = [
  {
    id: "ios",
    label: "iOS",
    store: "App Store",
  },
  {
    id: "android",
    label: "Android",
    store: "Google Play",
  },
];

export const SELF_HOST_GUIDE_URL =
  "https://github.com/SourceWeft/SourceWeft/blob/main/docker/README.md";

// `label`, `fileType`, and `archLabels` are platform/format/architecture
// identifiers, not UI copy, so they stay literal here. The system-requirement
// sentence is UI copy and lives in messages under `platforms.<id>.requirement`.
export type PlatformDisplay = {
  id: DownloadPlatform;
  label: string;
  fileType: string;
  archLabels: Record<DownloadArch, string>;
  archOrder: readonly DownloadArch[];
};

export const PLATFORM_DISPLAY: readonly PlatformDisplay[] = [
  {
    id: "macos",
    label: "macOS",
    fileType: "DMG",
    archLabels: { arm64: "Apple Silicon", x64: "Intel" },
    archOrder: ["arm64", "x64"],
  },
  {
    id: "windows",
    label: "Windows",
    fileType: "EXE installer",
    archLabels: { x64: "x64", arm64: "ARM64" },
    archOrder: ["x64", "arm64"],
  },
  {
    id: "linux",
    label: "Linux",
    fileType: "AppImage",
    archLabels: { x64: "x64", arm64: "ARM64" },
    archOrder: ["x64", "arm64"],
  },
];

export function platformDisplay(id: DownloadPlatform) {
  return PLATFORM_DISPLAY.find((entry) => entry.id === id)!;
}

// Native macOS window captures under public/download/desktop-<id>-{light,dark}.png.
// Title/caption copy lives in messages under `screens.items.<id>`.
export const DESKTOP_SCREENS = [
  { id: "execution-target" },
  { id: "working-directory" },
  { id: "skills" },
  { id: "mcp" },
] as const;

// FAQ copy lives in messages under `faq.items.<key>`; these keys drive both the
// on-page FAQ section and the FAQPage JSON-LD.
export const DOWNLOAD_FAQ_KEYS = [
  "desktopVsWeb",
  "macosVerification",
  "windowsSmartScreen",
  "updates",
  "previewBuild",
  "linuxBuild",
] as const;
