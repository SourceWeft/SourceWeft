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
