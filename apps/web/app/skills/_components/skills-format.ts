import { SUPPORT_EMAIL, skillsCopy } from "./skills-public-copy";

export const skillsContainerClassName = "max-w-7xl px-5 sm:px-6 lg:px-8";

export function skillPath(slug: string) {
  return `/skills/${encodeURIComponent(slug)}`;
}

export function skillCategoryPath(slug: string) {
  return `/skills/category/${encodeURIComponent(slug)}`;
}

export function skillCategoryLabel(
  slug: string,
  names?: ReadonlyMap<string, string>,
) {
  return (
    names?.get(slug) ??
    slug
      .split("-")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ")
  );
}

// --- Detail tabs -----------------------------------------------------------

export const skillDetailTabs = [
  "skill",
  "files",
  "versions",
  "install",
] as const;
export type SkillDetailTab = (typeof skillDetailTabs)[number];

export function parseSkillDetailTab(
  value: string | string[] | undefined,
): SkillDetailTab {
  const raw = Array.isArray(value) ? value[0] : value;
  return skillDetailTabs.find((tab) => tab === raw) ?? "skill";
}

/** The default tab has no query param, so the canonical URL is the bare path. */
export function skillTabHref(slug: string, tab: SkillDetailTab) {
  return tab === "skill" ? skillPath(slug) : `${skillPath(slug)}?tab=${tab}`;
}

// --- Install ---------------------------------------------------------------

/** Where the dashboard picks up a pending install of this skill. */
export function skillDashboardInstallPath(slug: string) {
  return `/dashboard/skills/${encodeURIComponent(slug)}?install=1`;
}

/**
 * Signed in: straight to the dashboard install. Signed out: the sign-in route
 * with `redirectTo` carrying that same path, the convention every other
 * sign-in return in the app uses.
 */
export function skillInstallHref(slug: string, signedIn: boolean) {
  const target = skillDashboardInstallPath(slug);
  return signedIn
    ? target
    : `/auth/sign-in?redirectTo=${encodeURIComponent(target)}`;
}

// --- Numbers and dates -----------------------------------------------------

function trimFraction(value: number) {
  return value.toFixed(1).replace(/\.0$/, "");
}

/** 0–999 as is, then 1.2K / 34K / 1.2M, always rounded down. */
export function formatCompactCount(value: number) {
  const whole = Math.max(0, Math.floor(value));
  if (whole < 1_000) return String(whole);
  if (whole < 10_000) return `${trimFraction(Math.floor(whole / 100) / 10)}K`;
  if (whole < 1_000_000) return `${Math.floor(whole / 1_000)}K`;
  return `${trimFraction(Math.floor(whole / 100_000) / 10)}M`;
}

const dateFormat = new Intl.DateTimeFormat("en", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
  year: "numeric",
});

/** Null for a missing or unparseable date, so callers can omit the field. */
export function formatSkillDate(value?: string | null) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : dateFormat.format(date);
}

/**
 * `1.2.0` reads as `v1.2.0`. Anything else is shown as it is — in particular a
 * community skill's version is a commit-hash prefix, and one that happens to
 * start with a digit (`5bf4e78…`) is still not a version number.
 */
export function formatSkillVersion(version: string) {
  return /^\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)
    ? `v${version}`
    : version;
}

export function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${trimFraction(bytes / 1024)} KB`;
  return `${trimFraction(bytes / (1024 * 1024))} MB`;
}

export function shortSeoText(value: string, maxLength = 180) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

// --- Source attribution ----------------------------------------------------

export function shortCommitSha(sha?: string | null) {
  return sha ? sha.slice(0, 7) : null;
}

/** Only http(s) URLs from the API are ever rendered as links. */
export function safeExternalUrl(value?: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

/** `owner/repo` for a GitHub-style URL, otherwise the host and path. */
/**
 * A logo we are willing to put in an <img>: the PNG thumbnail ingest makes, or
 * an https image. Nothing else — in particular no other data: type, since an
 * SVG data URL is a document, not a picture.
 */
export function safeSkillLogoUrl(value?: string | null) {
  if (!value) return null;
  if (/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) return value;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export function repoLabel(repoUrl: string) {
  try {
    const url = new URL(repoUrl);
    const path = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
    return path
      ? url.hostname === "github.com"
        ? path
        : `${url.hostname}/${path}`
      : url.hostname;
  } catch {
    return repoUrl;
  }
}

/** A commit permalink, for hosts whose URL shape we know (GitHub). */
export function commitUrl(repoUrl?: string | null, sha?: string | null) {
  const safeRepo = safeExternalUrl(repoUrl);
  if (!safeRepo || !sha || !/^[0-9a-f]{7,64}$/i.test(sha)) return null;
  const url = new URL(safeRepo);
  if (url.hostname !== "github.com") return null;
  const path = url.pathname.replace(/\/+$/, "").replace(/\.git$/, "");
  return `https://github.com${path}/commit/${sha}`;
}

/**
 * The command that installs this skill onto a local coding agent with the
 * upstream `skills` CLI — pinned to the commit we indexed and scanned, not to
 * whatever the branch points at today. We index third-party skills and do not
 * hand out their files, so a local install always goes to the source.
 *
 * Null unless the source is a GitHub repository with a full commit hash: a
 * short hash is not something `git fetch` can ask a server for.
 */
export function skillLocalInstallCommand(source: {
  repoUrl?: string | null;
  commitSha?: string | null;
  repoSubpath?: string | null;
}) {
  const repo =
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(
      source.repoUrl ?? "",
    );
  const sha = source.commitSha ?? "";
  if (!repo || !/^[0-9a-f]{40}$/i.test(sha)) return null;
  const subpath = (source.repoSubpath ?? "").replace(/^\/+|\/+$/g, "");
  // The path ends up in a shell command someone pastes: anything beyond plain
  // path characters means no command rather than a quoted one.
  if (subpath && !/^[A-Za-z0-9._/-]+$/.test(subpath)) return null;
  if (subpath.split("/").includes("..")) return null;
  const tree = `https://github.com/${repo[1]}/${repo[2]}/tree/${sha.toLowerCase()}`;
  return `npx skills add ${subpath ? `${tree}/${subpath}` : tree}`;
}

export function skillTakedownMailto(slug: string) {
  return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(
    `Skill takedown: ${slug}`,
  )}`;
}

export function scanFlagLabel(flag: string) {
  return skillsCopy.scanFlagLabels[flag] ?? flag;
}

// --- Untrusted markdown ----------------------------------------------------

/**
 * Strips only a complete leading YAML frontmatter block; the body is kept as
 * the author wrote it. Same rule as the dashboard's skill introduction.
 */
export function stripSkillFrontmatter(markdown: string | null | undefined) {
  return (markdown ?? "")
    .replace(/^\uFEFF/, "")
    .replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "")
    .trim();
}

// What HTML itself defines. A tag outside this list on a line of its own is an
// author's own marker (`<Good>`, `<example>`, `<EXTREMELY-IMPORTANT>`), which
// skills use heavily to structure instructions for a model.
const HTML_BLOCK_TAGS = new Set(
  "address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param pre script search section style summary table tbody td textarea tfoot th thead title tr track ul".split(
    " ",
  ),
);

/**
 * Puts an author's own marker tags on lines of their own, as inline code.
 *
 * To a markdown parser `<Good>` alone on a line opens an HTML block that runs
 * to the next blank line, so the code fence right under it is never parsed and
 * a whole example collapses into one run of text. Raw HTML is off here anyway
 * (the tag would show as literal text), so nothing is lost by showing it as
 * `<Good>` — and the markdown around it renders the way its author meant.
 * Lines inside a code fence are left exactly as they are.
 */
export function isolateSkillMarkerTags(markdown: string) {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (fence === null) fence = marker[0]!.repeat(marker.length);
      else if (marker[0] === fence[0] && marker.length >= fence.length)
        fence = null;
      out.push(line);
      continue;
    }
    const tag =
      fence === null
        ? /^\s{0,3}(<\/?([A-Za-z][A-Za-z0-9_-]*)>)\s*$/.exec(line)
        : null;
    if (tag && !HTML_BLOCK_TAGS.has(tag[2]!.toLowerCase())) {
      out.push("", `\`${tag[1]}\``, "");
      continue;
    }
    out.push(line);
  }
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const UNTRUSTED_LINK_REL = "nofollow ugc noopener noreferrer";

/**
 * What a link inside third-party markdown may point at. Absolute http(s) and
 * mailto links open in a new tab with {@link UNTRUSTED_LINK_REL}; in-page
 * anchors stay in the page. Everything else — relative paths into a repository
 * we do not serve, `javascript:`, `data:` — is not a link here and renders as
 * plain text.
 */
export function untrustedMarkdownLink(
  href: string | null | undefined,
):
  | { kind: "external"; href: string; rel: string; target: "_blank" }
  | { kind: "anchor"; href: string }
  | { kind: "text" } {
  const value = href?.trim();
  if (!value) return { kind: "text" };
  if (value.startsWith("#")) return { kind: "anchor", href: value };
  if (!/^(https?:\/\/|mailto:)/i.test(value)) return { kind: "text" };
  try {
    const url = new URL(value);
    if (!["http:", "https:", "mailto:"].includes(url.protocol)) {
      return { kind: "text" };
    }
    return {
      href: url.toString(),
      kind: "external",
      rel: UNTRUSTED_LINK_REL,
      target: "_blank",
    };
  } catch {
    return { kind: "text" };
  }
}
