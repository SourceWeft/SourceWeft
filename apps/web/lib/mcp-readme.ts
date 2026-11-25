import type {
  GetMarketMcpResponse,
  MarketMcpReadme,
  MarketMcpReadmeSource,
} from "@sourceweft/market-contracts";

import {
  untrustedMarkdownLink,
  type UntrustedMarkdownBaseUrl,
  type UntrustedMarkdownLink,
} from "../app/_components/market/untrusted-markdown-links";

/**
 * The README of an MCP detail response (`GET /v1/mcp/:identifier`, and the
 * workspace detail, whose `market` is that response); null when there is none
 * to read: no published version, or an answer from before READMEs existed.
 */
export function readMcpReadme(
  detail: Pick<GetMarketMcpResponse, "readme">,
): MarketMcpReadme | null {
  return detail.readme ?? null;
}

/**
 * What the README's relative links and images resolve against: its own
 * addresses at the commit it was read at. None without a known README file.
 */
export function mcpReadmeBaseUrl(
  source: Pick<MarketMcpReadmeSource, "blobUrl" | "rawUrl"> | null | undefined,
): UntrustedMarkdownBaseUrl | undefined {
  return source ? { blob: source.blobUrl, raw: source.rawUrl } : undefined;
}

/**
 * The repository a reader can open instead when the README could not be read
 * (a fetch `error`, or a host we do not read), as a link to third-party
 * content; null when there is no README file to name or its repository has no
 * safe address.
 */
export function mcpReadmeFallbackLink(
  readme: MarketMcpReadme | null,
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
  readme: MarketMcpReadme | null,
): readme is MarketMcpReadme {
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

/**
 * The most README source a public MCP page renders. The text is written into
 * the page twice (as HTML and again in the data the page hydrates from), so a
 * 130 KB README made a 1.8 MB page. The part past this is one click away at
 * the pinned commit.
 */
export const MCP_README_RENDER_LIMIT = 40_000;

/**
 * The README cut to its first {@link MCP_README_RENDER_LIMIT} characters, at
 * the end of a paragraph and never inside a code fence; unchanged when it is
 * already short enough.
 */
export function limitMcpReadme(markdown: string): {
  markdown: string;
  truncated: boolean;
} {
  if (markdown.length <= MCP_README_RENDER_LIMIT) {
    return { markdown, truncated: false };
  }
  const head = markdown.slice(0, MCP_README_RENDER_LIMIT);
  // A paragraph break at or before the limit that is outside a code fence.
  let fence: string | null = null;
  let offset = 0;
  let cut = 0;
  let previousBlank = false;
  for (const line of head.split("\n")) {
    const outside = fence === null;
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) {
        fence = null;
      }
    }
    if (outside && previousBlank && line.trim() !== "" && offset > 0) {
      cut = offset;
    }
    previousBlank = line.trim() === "";
    offset += line.length + 1;
  }
  return {
    markdown: markdown
      .slice(0, cut > 0 ? cut : MCP_README_RENDER_LIMIT)
      .trimEnd(),
    truncated: true,
  };
}
