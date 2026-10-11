// The "Listed on SourceWeft" README badge: its picture and the snippets that
// embed it. Free of server-only imports — the badge routes render the SVG, and
// the snippet panel builds the same URLs in the browser.

import { mcpPath } from "../app/[locale]/mcp/_components/mcp-paths";
import { skillPath } from "../app/[locale]/skills/_components/skills-format";

export type CatalogBadgeKind = "mcp" | "skill";

/** A listed catalog entry: an MCP server's identifier or a skill's slug. */
export type CatalogBadgeTarget = { kind: CatalogBadgeKind; key: string };

export type CatalogBadgeUrls = { badgeUrl: string; detailUrl: string };

/** The badge's text alternative. English: READMEs are read worldwide. */
export const LISTED_BADGE_ALT = "Listed on SourceWeft";

// Lets analytics tell badge visits apart from other GitHub referrals.
const BADGE_CAMPAIGN = "utm_source=readme&utm_medium=badge";

/**
 * RFC 3986 strict: `encodeURIComponent` leaves `!'()*` alone, and `(`/`)` end
 * a Markdown link, `'` an attribute.
 */
function strictEncode(path: string) {
  return path.replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * The badge picture and the canonical page it links to. Always the English
 * page, with no locale prefix: a README is not in the reader's language, and
 * the page negotiates its own.
 */
export function catalogBadgeUrls(
  target: CatalogBadgeTarget,
  siteUrl: string,
): CatalogBadgeUrls {
  const site = siteUrl.replace(/\/+$/, "");
  const segment = strictEncode(encodeURIComponent(target.key));
  const page =
    target.kind === "mcp" ? mcpPath(target.key) : skillPath(target.key);
  const badgeDir = target.kind === "mcp" ? "mcp" : "skills";
  return {
    badgeUrl: `${site}/badge/${badgeDir}/${segment}.svg`,
    detailUrl: `${site}${strictEncode(page)}?${BADGE_CAMPAIGN}`,
  };
}

export function badgeMarkdown({ badgeUrl, detailUrl }: CatalogBadgeUrls) {
  return `[![${LISTED_BADGE_ALT}](${badgeUrl})](${detailUrl})`;
}

function escapeAttribute(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function badgeHtml({ badgeUrl, detailUrl }: CatalogBadgeUrls) {
  return `<a href="${escapeAttribute(detailUrl)}"><img src="${escapeAttribute(badgeUrl)}" alt="${LISTED_BADGE_ALT}" height="20"></a>`;
}

/**
 * The SourceWeft mark: the glyph of `public/icon.svg`, which
 * `scripts/generate-icons.mjs` produces (a test keeps the two identical). It
 * sits in an 800×800 box, at x 33.4–766.6 and y 125.6–674.4.
 */
export const LISTED_BADGE_MARK_PATH =
  "M766.6 125.674h-83.275L624.072 376.14l48.525 141.407zM436.545 256.192h-80.873l128.916 418.137h32.83l24.822-86.477zm88.88 0-24.662 85.677 102.492 332.46h34.751l19.698-86.477-104.094-331.66zm-129.717-33.63v-96.888H200.813q-88.238.16-128.115 41.958Q31.86 209.59 33.462 274.128t42.6 95.446q31.068 23.38 75.268 48.205l106.814 56.53q46.282 25.143 38.275 62.937-8.167 37.634-57.172 39.556H36.185v97.527h215.073q48.202-2.562 81.674-22.902 53.168-32.51 65.178-101.371 10.89-93.843-76.709-148.934-111.3-61.015-165.909-99.45-27.545-19.377-18.897-47.724 9.449-31.388 58.933-31.388h200.18z";

// Shields' flat style: 20px high, Verdana 11px, 5px padding, a 14px logo with
// 3px before its text. Text widths are Verdana's advances, pinned with
// `textLength` (in tenths, as drawn at `scale(.1)`) so a fallback font keeps
// the layout. The SVG carries no entry data at all: nothing to escape.
const LEFT_WIDTH = 57; // 5 + "listed on" (47) + 5
const LOGO_X = LEFT_WIDTH + 5;
const TEXT_X = LOGO_X + 14 + 3;
const RIGHT_TEXT_WIDTH = 64; // "SourceWeft"
/** The badge is this many pixels wide, and 20 high. */
export const LISTED_BADGE_WIDTH = TEXT_X + RIGHT_TEXT_WIDTH + 5;
const WIDTH = LISTED_BADGE_WIDTH;
const LABEL_FILL = "#555";
// The page background of the public site, with its zinc-950 text: legible on
// GitHub's light and dark themes alike.
const BRAND_FILL = "#f7f4ed";
const BRAND_TEXT = "#09090b";
// Scales the glyph to 14px wide, centred on the badge's middle line.
const MARK_SCALE = 14 / 733.2;
const MARK_TRANSFORM = `translate(${(LOGO_X - 33.4 * MARK_SCALE).toFixed(3)} ${(10 - (548.8 * MARK_SCALE) / 2 - 125.6 * MARK_SCALE).toFixed(3)}) scale(${MARK_SCALE.toFixed(6)})`;

const LISTED_BADGE_SVG = [
  `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="20" viewBox="0 0 ${WIDTH} 20" role="img" aria-label="${LISTED_BADGE_ALT}">`,
  `<title>${LISTED_BADGE_ALT}</title>`,
  `<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>`,
  `<clipPath id="r"><rect width="${WIDTH}" height="20" rx="3" fill="#fff"/></clipPath>`,
  `<g clip-path="url(#r)">`,
  `<rect width="${LEFT_WIDTH}" height="20" fill="${LABEL_FILL}"/>`,
  `<rect x="${LEFT_WIDTH}" width="${WIDTH - LEFT_WIDTH}" height="20" fill="${BRAND_FILL}"/>`,
  `<rect width="${WIDTH}" height="20" fill="url(#s)"/>`,
  `</g>`,
  `<g text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="110">`,
  `<text aria-hidden="true" x="${(LEFT_WIDTH / 2) * 10}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="470">listed on</text>`,
  `<text x="${(LEFT_WIDTH / 2) * 10}" y="140" fill="#fff" transform="scale(.1)" textLength="470">listed on</text>`,
  `<text aria-hidden="true" x="${(TEXT_X + RIGHT_TEXT_WIDTH / 2) * 10}" y="150" fill="#ccc" fill-opacity=".3" transform="scale(.1)" textLength="${RIGHT_TEXT_WIDTH * 10}">SourceWeft</text>`,
  `<text x="${(TEXT_X + RIGHT_TEXT_WIDTH / 2) * 10}" y="140" fill="${BRAND_TEXT}" transform="scale(.1)" textLength="${RIGHT_TEXT_WIDTH * 10}">SourceWeft</text>`,
  `</g>`,
  `<path fill="${BRAND_TEXT}" transform="${MARK_TRANSFORM}" d="${LISTED_BADGE_MARK_PATH}"/>`,
  `</svg>`,
].join("");

/** The badge for every listed entry: one fixed picture, no entry text. */
export function renderListedBadgeSvg() {
  return LISTED_BADGE_SVG;
}

/**
 * A strong ETag for a badge picture: FNV-1a (32-bit) over its UTF-16 code
 * units. Plain arithmetic, since the snippet panel loads this module in the
 * browser too. It only has to change when the picture does.
 */
export function badgeEtag(svg: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < svg.length; index += 1) {
    hash ^= svg.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `"sw-listed-${(hash >>> 0).toString(16).padStart(8, "0")}"`;
}

/**
 * Every listed entry gets the same picture, so one ETag serves them all. It
 * is derived from the picture, so changing the SVG changes it.
 */
export const LISTED_BADGE_ETAG = badgeEtag(LISTED_BADGE_SVG);
