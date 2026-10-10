import type { DesktopInfo } from "./desktop-bridge";

export type DesktopRecoveryRelease = {
  version: string;
  affectedVersions: string[];
  downloads: Record<string, string>;
};

const targets = [
  "macos-aarch64",
  "macos-x86_64",
  "windows-x86_64",
  "linux-x86_64",
];
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** An absent configuration is the release gate. Never infer publication from a version. */
export function parseDesktopRecoveryRelease(
  raw: string,
): DesktopRecoveryRelease | undefined {
  if (!raw.trim()) return undefined;
  const invalid = () =>
    new Error(
      "Invalid PUBLIC_DESKTOP_RECOVERY_RELEASE: require a published release, affected versions and official installer URLs",
    );
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw invalid();
  }
  if (
    !value ||
    value.published !== true ||
    typeof value.version !== "string" ||
    !versionPattern.test(value.version) ||
    !Array.isArray(value.affectedVersions) ||
    !value.affectedVersions.length ||
    value.affectedVersions.some(
      (v: unknown) =>
        typeof v !== "string" || !versionPattern.test(v) || v === value.version,
    ) ||
    !value.downloads ||
    typeof value.downloads !== "object" ||
    Array.isArray(value.downloads) ||
    !Object.keys(value.downloads).length
  )
    throw invalid();
  for (const [target, url] of Object.entries(value.downloads)) {
    if (!targets.includes(target) || typeof url !== "string") throw invalid();
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw invalid();
    }
    const extension = target.startsWith("macos-")
      ? ".dmg"
      : target.startsWith("windows-")
        ? ".exe"
        : ".AppImage";
    if (
      parsed.origin !== "https://download.sourceweft.com" ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      !parsed.pathname.startsWith(`/releases/v${value.version}/`) ||
      !parsed.pathname.endsWith(extension)
    )
      throw invalid();
  }
  return {
    version: value.version,
    affectedVersions: value.affectedVersions,
    downloads: value.downloads,
  };
}

export function recoveryDownload(
  release: DesktopRecoveryRelease | undefined,
  info: DesktopInfo,
) {
  if (
    !release ||
    !info.isDesktop ||
    !release.affectedVersions.includes(info.appVersion)
  )
    return null;
  return release.downloads[`${info.platform}-${info.arch}`] ?? null;
}

export function localCalendarDate(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function recoveryDismissalKey(info: DesktopInfo) {
  // Shared across accounts and campaigns: "later" always means the whole local day.
  return `sourceweft:desktop-recovery-dismissed:${info.platform}:${info.arch}`;
}
