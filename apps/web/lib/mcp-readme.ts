import {
  untrustedMarkdownLink,
  type UntrustedMarkdownBaseUrl,
  type UntrustedMarkdownLink,
} from "../app/_components/market/untrusted-markdown-links";

/** Where an MCP server's README stands; `pending` until it is first fetched. */
export type McpReadmeStatus =
  "error" | "not_found" | "ok" | "pending" | "too_large" | "unsupported_host";

/**
 * The README file the server's repository was read at. `blobUrl` and `rawUrl`
 * are the file's OWN addresses at the pinned commit `ref`, e.g.
 * `https://github.com/o/r/blob/<sha>/mcp/README.md`, so a relative reference in
 * it resolves the way a browser resolves it on that page.
 */
export type McpReadmeSource = {
  repoUrl: string;
  ref: string | null;
  path: string | null;
  blobUrl: string | null;
  rawUrl: string | null;
};

// TODO(#151): replace with the @sourceweft/market-contracts type once B2 lands
/**
 * `readme` on the MCP detail responses (`GET /v1/mcp/:identifier`, and the
 * workspace detail, whose `market` is that response). `markdown` is present
 * only when `status` is `ok`, and it is the author's text: render it as
 * untrusted markdown (McpReadmeSection), never as trusted markup. `source` is
 * null when no README file is known.
 */
export type McpReadmePayload = {
  status: McpReadmeStatus;
  markdown?: string;
  source: McpReadmeSource | null;
};

const README_STATUSES: ReadonlySet<string> = new Set([
  "error",
  "not_found",
  "ok",
  "pending",
  "too_large",
  "unsupported_host",
] satisfies McpReadmeStatus[]);

function text(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readSource(value: unknown): McpReadmeSource | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const repoUrl = text(source.repoUrl);
  if (!repoUrl) return null;
  return {
    blobUrl: text(source.blobUrl),
    path: text(source.path),
    rawUrl: text(source.rawUrl),
    ref: text(source.ref),
    repoUrl,
  };
}

/**
 * The `readme` of an MCP detail response, read defensively: a response without
 * it (list endpoints, or an API from before it existed) or with a shape this
 * page does not know means there is no README to show — null.
 */
export function readMcpReadme(detail: unknown): McpReadmePayload | null {
  if (!detail || typeof detail !== "object") return null;
  const readme = (detail as { readme?: unknown }).readme;
  if (!readme || typeof readme !== "object") return null;
  const { markdown, source, status } = readme as Record<string, unknown>;
  if (typeof status !== "string" || !README_STATUSES.has(status)) return null;
  return {
    status: status as McpReadmeStatus,
    ...(status === "ok" && typeof markdown === "string" ? { markdown } : {}),
    source: readSource(source),
  };
}

/**
 * What the README's relative links and images resolve against: its own
 * addresses, which it has only when both are known.
 */
export function mcpReadmeBaseUrl(
  source: Pick<McpReadmeSource, "blobUrl" | "rawUrl"> | null | undefined,
): UntrustedMarkdownBaseUrl | undefined {
  return source?.blobUrl && source.rawUrl
    ? { blob: source.blobUrl, raw: source.rawUrl }
    : undefined;
}

/**
 * The repository a reader can open instead when the README could not be read
 * (a fetch `error`, or a host we do not read), as a link to third-party
 * content; null when it has no safe address.
 */
export function mcpReadmeFallbackLink(
  readme: McpReadmePayload | null,
): Extract<UntrustedMarkdownLink, { kind: "external" }> | null {
  if (readme?.status !== "error" && readme?.status !== "unsupported_host") {
    return null;
  }
  const link = untrustedMarkdownLink(readme.source?.repoUrl);
  return link.kind === "external" ? link : null;
}

/**
 * Whether a README section (or dialog tab) has anything to show: the README,
 * why there is none (`not_found`, `too_large`), or where to read it instead.
 * Nothing while it is `pending`.
 */
export function hasMcpReadmeToShow(
  readme: McpReadmePayload | null,
): readme is McpReadmePayload {
  switch (readme?.status) {
    case "ok":
      return Boolean(readme.markdown);
    case "not_found":
    case "too_large":
      return true;
    case "error":
    case "unsupported_host":
      return mcpReadmeFallbackLink(readme) !== null;
    default:
      return false;
  }
}

// Roughly one screen of rendered README (text-sm, leading-7, with the spacing
// headings and paragraphs add). Past either, the public page folds it.
const LONG_README_LINES = 30;
const LONG_README_CHARACTERS = 3000;

/**
 * Whether a README is long enough to fold behind "Show full README". Decided
 * from the source, on the server, so the folded layout is what the first paint
 * already shows and nothing moves when the page hydrates.
 */
export function isLongMcpReadme(markdown: string | undefined) {
  if (!markdown) return false;
  return (
    markdown.length >= LONG_README_CHARACTERS ||
    markdown.split("\n").length >= LONG_README_LINES
  );
}
