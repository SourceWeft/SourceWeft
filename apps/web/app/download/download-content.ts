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
    requirement: "Builds not published yet",
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
      "Current builds are not yet signed with an Apple Developer certificate or notarized. Compare the SHA-256 checksum shown on this page, then Control-click the app, choose Open, and confirm.",
  },
  {
    question: "Why does Windows SmartScreen warn about the installer?",
    answer:
      "The installer is not yet signed with a distribution certificate. Verify the SHA-256 checksum first, then choose More info and Run anyway.",
  },
  {
    question: "How do updates work?",
    answer:
      "In-app updates are not available yet. Download the latest installer from this page and run it over the existing installation. The changelog lists what changed in each release.",
  },
  {
    question: "What is a preview build?",
    answer:
      "Preview builds are release candidates published from pre-release tags before a stable release. They may change before the stable version ships.",
  },
  {
    question: "Is there a Linux build?",
    answer:
      "Not yet. The web app works in any modern browser on Linux, and Linux installers will appear on this page as soon as they are published.",
  },
] as const;
