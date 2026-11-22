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
const HANDLE_RE = /^@[A-Za-z0-9._-]{3,30}$/;

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

  if (first === "shorts" || first === "live" || first === "embed") {
    if (second && VIDEO_ID_RE.test(second)) {
      return { kind: "video", videoId: second };
    }
    return null;
  }

  if (first && first.startsWith("@")) {
    if (HANDLE_RE.test(first)) {
      return { kind: "channel", channel: { type: "handle", value: first.slice(1) } };
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
    if (second) {
      return { kind: "channel", channel: { type: "user", value: second } };
    }
    return null;
  }

  if (first === "c") {
    if (second) {
      return { kind: "channel", channel: { type: "custom", value: second } };
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
