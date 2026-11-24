/**
 * YouTube URL parsing.
 *
 * Browser-safe: this module must not import any `node:*` builtin, since the
 * web app imports it directly (see package.json's `./youtube-url` export).
 * Parsing relies only on the global `URL`.
 */

export type YouTubeChannelRef = {
  type: "id" | "handle" | "user" | "custom";
  value: string;
};

export type YouTubeUrlTarget =
  | { kind: "video"; videoId: string }
  | { kind: "playlist"; playlistId: string }
  | { kind: "channel"; channel: YouTubeChannelRef };

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const PLAYLIST_ID_RE = /^[A-Za-z0-9_-]{10,64}$/;
const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;
// YouTube handles may use letters and digits of any script (`@小明频道`), plus
// marks for scripts that need them and the separators YouTube allows.
const HANDLE_RE = /^@[\p{L}\p{N}\p{M}._·-]{3,30}$/u;

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
  "youtu.be",
]);

export function isYouTubeHost(hostname: string): boolean {
  return YOUTUBE_HOSTS.has(hostname.toLowerCase());
}

function toUrl(input: string): URL | null {
  try {
    return new URL(input);
  } catch {
    // Allow scheme-less input such as "youtube.com/watch?v=...".
  }
  try {
    return new URL(`https://${input}`);
  } catch {
    return null;
  }
}

function splitPath(pathname: string): string[] {
  return pathname.split("/").filter((segment) => segment.length > 0);
}

/**
 * A path segment as the user wrote it: `URL` percent-encodes non-ASCII
 * characters, and a pasted link may already be encoded. Decoded exactly once
 * here, so a channel reference carries its plain value and whoever builds a
 * URL from it encodes it exactly once. `null` for a malformed escape.
 */
function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

export function parseYouTubeUrl(input: string): YouTubeUrlTarget | null {
  const url = toUrl(input);
  if (!url) return null;

  const hostname = url.hostname.toLowerCase();
  if (!isYouTubeHost(hostname)) return null;

  const segments = splitPath(url.pathname);
  const [first, second] = segments;

  if (hostname === "youtu.be") {
    if (first && VIDEO_ID_RE.test(first)) {
      return { kind: "video", videoId: first };
    }
    return null;
  }

  if (first === "watch") {
    const v = url.searchParams.get("v");
    if (v && VIDEO_ID_RE.test(v)) {
      // A `list`/`index` pair alongside `v` is still a single-video link
      // (the user is watching a video that happens to sit in a playlist).
      return { kind: "video", videoId: v };
    }
    return null;
  }

  if (first === "playlist") {
    const list = url.searchParams.get("list");
    if (list && PLAYLIST_ID_RE.test(list)) {
      return { kind: "playlist", playlistId: list };
    }
    return null;
  }

  if (first === "embed" && second === "videoseries") {
    const list = url.searchParams.get("list");
    if (list && PLAYLIST_ID_RE.test(list)) {
      return { kind: "playlist", playlistId: list };
    }
    return null;
  }

  if (first === "shorts" || first === "live" || first === "embed" || first === "v") {
    if (second && VIDEO_ID_RE.test(second)) {
      return { kind: "video", videoId: second };
    }
    return null;
  }

  if (first && first.startsWith("@")) {
    const handle = decodeSegment(first);
    if (handle && HANDLE_RE.test(handle)) {
      return { kind: "channel", channel: { type: "handle", value: handle.slice(1) } };
    }
    return null;
  }

  if (first === "channel") {
    if (second && CHANNEL_ID_RE.test(second)) {
      return { kind: "channel", channel: { type: "id", value: second } };
    }
    return null;
  }

  if (first === "user") {
    const user = second ? decodeSegment(second) : null;
    if (user) {
      return { kind: "channel", channel: { type: "user", value: user } };
    }
    return null;
  }

  if (first === "c") {
    const custom = second ? decodeSegment(second) : null;
    if (custom) {
      return { kind: "channel", channel: { type: "custom", value: custom } };
    }
    return null;
  }

  return null;
}

export function isUnrecognisedYouTubeUrl(input: string): boolean {
  const url = toUrl(input);
  if (!url) return false;
  if (!isYouTubeHost(url.hostname.toLowerCase())) return false;
  return parseYouTubeUrl(input) === null;
}

export function canonicalVideoUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export function timestampUrl(videoId: string, seconds: number): string {
  return `${canonicalVideoUrl(videoId)}&t=${Math.floor(seconds)}s`;
}
