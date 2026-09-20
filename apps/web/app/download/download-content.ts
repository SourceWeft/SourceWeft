import type {
  DownloadArch,
  DownloadPlatform,
} from "../../lib/download-channels";

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

export type MobilePlatformDisplay = {
  id: "ios" | "android";
  label: string;
  store: string;
  storeAction: string;
  devices: string;
};

export const MOBILE_PLATFORMS: readonly MobilePlatformDisplay[] = [
  {
    id: "ios",
    label: "iOS",
    store: "App Store",
    storeAction: "Download on the App Store",
    devices: "iPhone and iPad",
  },
  {
    id: "android",
    label: "Android",
    store: "Google Play",
    storeAction: "Get it on Google Play",
    devices: "Phones and tablets",
  },
];

export const SELF_HOST_GUIDE_URL =
  "https://github.com/SourceWeft/SourceWeft/blob/main/docker/README.md";

export type PlatformDisplay = {
  id: DownloadPlatform;
  label: string;
  fileType: string;
  requirement: string;
  archLabels: Record<DownloadArch, string>;
  archOrder: readonly DownloadArch[];
};

export const PLATFORM_DISPLAY: readonly PlatformDisplay[] = [
  {
    id: "macos",
    label: "macOS",
    fileType: "DMG",
    requirement: "macOS 11 or later",
    archLabels: { arm64: "Apple Silicon", x64: "Intel" },
    archOrder: ["arm64", "x64"],
  },
  {
    id: "windows",
    label: "Windows",
    fileType: "EXE installer",
    requirement: "Windows 10 or later, 64-bit",
    archLabels: { x64: "x64", arm64: "ARM64" },
    archOrder: ["x64", "arm64"],
  },
  {
    id: "linux",
    label: "Linux",
    fileType: "AppImage",
    requirement: "Ubuntu 22.04 / Debian 12 or later, x64 (AppImage)",
    archLabels: { x64: "x64", arm64: "ARM64" },
    archOrder: ["x64", "arm64"],
  },
];

export function platformDisplay(id: DownloadPlatform) {
  return PLATFORM_DISPLAY.find((entry) => entry.id === id)!;
}

export const DESKTOP_HIGHLIGHTS = [
  "The same account, workspaces, and chats as the web app",
  "A native window instead of a browser tab",
  "Local working directories and file panels on macOS",
  "Desktop MCP servers that need a local process",
] as const;

// Native macOS window captures under public/download/desktop-<id>-{light,dark}.png.
export const DESKTOP_SCREENS = [
  {
    id: "execution-target",
    title: "Run in the cloud or on this computer",
    caption:
      "Pick where each chat executes. Your Mac shows up as an online device the moment the app is running.",
  },
  {
    id: "working-directory",
    title: "Work inside a local folder",
    caption:
      "Give a chat a working directory so files it reads and writes stay on your machine.",
  },
  {
    id: "skills",
    title: "Install skills into a workspace",
    caption:
      "Browse official and community skills, then enable them per workspace from the same window.",
  },
  {
    id: "mcp",
    title: "Connect MCP servers, including desktop-only ones",
    caption:
      "STDIO servers that need a local process are available here because the desktop app hosts them.",
  },
] as const;

export const DOWNLOAD_FAQ_ITEMS = [
  {
    question: "Is the desktop app different from the web app?",
    answer:
      "It signs in to the same SourceWeft account and opens the same workspaces, chats, and sources. On top of that it adds a native window and, on macOS, local device capabilities such as working directories and file panels.",
  },
  {
    question: "Why does macOS say the app cannot be verified?",
    answer:
      "Earlier verification builds were not signed or notarized. Check the release’s signing information and compare its SHA-256 checksum before installing. Signed releases are built with an Apple Developer certificate and notarization.",
  },
  {
    question: "Why does Windows SmartScreen warn about the installer?",
    answer:
      "Earlier verification installers were unsigned. Check the release’s signing information and SHA-256 checksum before proceeding. The signed release pipeline uses a Windows code-signing certificate.",
  },
  {
    question: "How do updates work?",
    answer:
      "Updater-enabled clients check and download in the background, then ask before installation. Choose Stable or Preview in Settings → About → Software update. Older clients require one manual installation of an updater-enabled release. Linux in-app updates use the AppImage package.",
  },
  {
    question: "What is a preview build?",
    answer:
      "Preview builds are release candidates published from pre-release tags before a stable release. They may change before the stable version ships.",
  },
  {
    question: "Is there a Linux build?",
    answer:
      "Linux x64 is packaged as an AppImage. When a release is published, its download appears above. Make the downloaded file executable and run it; some distributions require FUSE 2. AppImage updates use the same stable and preview channels. Local device execution still requires macOS.",
  },
] as const;
