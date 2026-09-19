// Website integration for the desktop download channels published by
// scripts/ci/publish-downloads.mjs. See scripts/ci/README.downloads.md for the
// publication contract this module consumes.

export const DOWNLOADS_BASE_URL = "https://download.sourceweft.com";
export const GITHUB_RELEASES_URL =
  "https://github.com/SourceWeft/SourceWeft/releases";

export const DOWNLOAD_PLATFORMS = ["macos", "windows", "linux"] as const;
export const DOWNLOAD_ARCHS = ["arm64", "x64"] as const;
export const DOWNLOAD_CHANNELS = ["stable", "preview"] as const;

export type DownloadPlatform = (typeof DOWNLOAD_PLATFORMS)[number];
export type DownloadArch = (typeof DOWNLOAD_ARCHS)[number];
export type DownloadChannel = (typeof DOWNLOAD_CHANNELS)[number];

export type DownloadArtifact = {
  platform: DownloadPlatform;
  arch: DownloadArch;
  filename: string;
  size: number;
  sha256: string;
  url: string;
  githubUrl: string;
  distributionSigned: boolean;
  notarized: boolean;
  localExecutionSupported: boolean;
};

export type DownloadChannelManifest = {
  schemaVersion: 1;
  version: string;
  tag: string;
  channel: DownloadChannel;
  releaseNotesUrl: string;
  artifacts: DownloadArtifact[];
};

export type DownloadChannels = Record<
  DownloadChannel,
  DownloadChannelManifest | null
>;

const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._ -]*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const VERSION = /^[\w.-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function includes<T extends string>(
  list: readonly T[],
  value: unknown,
): value is T {
  return (
    typeof value === "string" && (list as readonly string[]).includes(value)
  );
}

function parseArtifact(value: unknown): DownloadArtifact | null | undefined {
  if (!isRecord(value)) return null;
  // Platforms this page does not know how to present are skipped rather than
  // failing the whole manifest, so publishing a new platform is not a breaking change.
  if (!includes(DOWNLOAD_PLATFORMS, value.platform)) return undefined;
  const url = httpsUrl(value.url);
  const githubUrl = httpsUrl(value.githubUrl);
  if (
    !includes(DOWNLOAD_ARCHS, value.arch) ||
    typeof value.filename !== "string" ||
    !SAFE_FILENAME.test(value.filename) ||
    typeof value.size !== "number" ||
    !Number.isSafeInteger(value.size) ||
    value.size <= 0 ||
    typeof value.sha256 !== "string" ||
    !SHA256.test(value.sha256) ||
    !url ||
    !githubUrl ||
    typeof value.distributionSigned !== "boolean" ||
    typeof value.notarized !== "boolean" ||
    typeof value.localExecutionSupported !== "boolean"
  ) {
    return null;
  }
  return {
    platform: value.platform,
    arch: value.arch,
    filename: value.filename,
    size: value.size,
    sha256: value.sha256,
    url,
    githubUrl,
    distributionSigned: value.distributionSigned,
    notarized: value.notarized,
    localExecutionSupported: value.localExecutionSupported,
  };
}

/**
 * Validates a channel manifest document. Returns null for anything that does
 * not match the published schema so a corrupted or tampered document degrades
 * to the "no channel" state instead of rendering unexpected links.
 */
export function parseChannelManifest(
  value: unknown,
  expectedChannel?: DownloadChannel,
): DownloadChannelManifest | null {
  if (!isRecord(value) || value.schemaVersion !== 1) return null;
  const releaseNotesUrl = httpsUrl(value.releaseNotesUrl);
  if (
    typeof value.version !== "string" ||
    !VERSION.test(value.version) ||
    typeof value.tag !== "string" ||
    !VERSION.test(value.tag) ||
    !includes(DOWNLOAD_CHANNELS, value.channel) ||
    (expectedChannel && value.channel !== expectedChannel) ||
    !releaseNotesUrl ||
    !Array.isArray(value.artifacts)
  ) {
    return null;
  }
  const artifacts: DownloadArtifact[] = [];
  const seen = new Set<string>();
  for (const entry of value.artifacts) {
    const artifact = parseArtifact(entry);
    if (artifact === undefined) continue;
    if (artifact === null) return null;
    const id = `${artifact.platform}-${artifact.arch}`;
    if (seen.has(id)) return null;
    seen.add(id);
    artifacts.push(artifact);
  }
  if (artifacts.length === 0) return null;
  return {
    schemaVersion: 1,
    version: value.version,
    tag: value.tag,
    channel: value.channel,
    releaseNotesUrl,
    artifacts,
  };
}

export function channelManifestUrl(
  channel: DownloadChannel,
  baseUrl = DOWNLOADS_BASE_URL,
) {
  return `${baseUrl}/channels/${channel}.json`;
}

/** Cache window for the channel documents. They are published with no-cache
 * headers, so this is the only cache between the site and the bucket. */
export const DOWNLOAD_CHANNEL_REVALIDATE_SECONDS = 300;

export async function fetchDownloadChannel(
  channel: DownloadChannel,
  fetchImpl: typeof fetch = fetch,
  baseUrl = DOWNLOADS_BASE_URL,
): Promise<DownloadChannelManifest | null> {
  try {
    const response = await fetchImpl(channelManifestUrl(channel, baseUrl), {
      headers: { accept: "application/json" },
      next: { revalidate: DOWNLOAD_CHANNEL_REVALIDATE_SECONDS },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return null;
    return parseChannelManifest(await response.json(), channel);
  } catch {
    // An unreachable bucket must not take the page down; the page falls back
    // to GitHub Releases links.
    return null;
  }
}

export async function fetchDownloadChannels(
  fetchImpl: typeof fetch = fetch,
  baseUrl = DOWNLOADS_BASE_URL,
): Promise<DownloadChannels> {
  const [stable, preview] = await Promise.all(
    DOWNLOAD_CHANNELS.map((channel) =>
      fetchDownloadChannel(channel, fetchImpl, baseUrl),
    ),
  );
  return { stable: stable ?? null, preview: preview ?? null };
}

export function findArtifact(
  manifest: DownloadChannelManifest | null,
  platform: DownloadPlatform,
  arch?: DownloadArch,
): DownloadArtifact | null {
  if (!manifest) return null;
  return (
    manifest.artifacts.find(
      (artifact) =>
        artifact.platform === platform && (!arch || artifact.arch === arch),
    ) ?? null
  );
}

export function formatArtifactSize(bytes: number) {
  const mb = bytes / (1024 * 1024);
  return mb >= 100 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}
