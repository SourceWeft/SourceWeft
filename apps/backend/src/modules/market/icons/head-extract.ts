import { parse } from "parse5";
import type { DefaultTreeAdapterMap } from "parse5";

/**
 * Pure `<head>` extraction for the icon dry-run (Issue #367). A reviewed,
 * non-executing HTML parser (parse5) builds the tree from the already
 * size-capped page; nothing in it runs. Only these are read: the
 * `rel=icon|apple-touch-icon|mask-icon` links, the web-app-manifest link and
 * the `<title>` text. Never read: `og:image` or any other `<meta>`, page
 * descriptions, the body. `<base>` is ignored — relative references resolve
 * against the address the page was fetched from, so a page cannot steer a
 * fetch to another origin with a `<base href>`.
 */

type Element = DefaultTreeAdapterMap["element"];
type ChildNode = DefaultTreeAdapterMap["childNode"];

export type HeadIconRel = "icon" | "apple-touch-icon" | "mask-icon";

export type DeclaredIcon = {
  rel: HeadIconRel | "manifest-icon";
  /** Absolute http(s) URL, resolved against the page or manifest address. */
  url: string;
  /** The largest side the declaration claims, when it states sizes. */
  size?: number;
  /** The declared MIME type, lowercased, when stated. */
  type?: string;
};

export type HeadSignals = {
  icons: DeclaredIcon[];
  manifestUrl?: string;
  title?: string;
};

const MAX_DECLARATIONS = 64;
const MAX_URL_LENGTH = 2048;
const MAX_TITLE_LENGTH = 200;

function attr(element: Element, name: string) {
  return element.attrs.find((a) => a.name === name)?.value;
}

function children(node: { childNodes?: ChildNode[] }): ChildNode[] {
  return node.childNodes ?? [];
}

function isElement(node: ChildNode, name?: string): node is Element {
  return (
    "tagName" in node && (name === undefined || node.tagName === name)
  );
}

function textOf(element: Element) {
  return children(element)
    .map((child) => ("value" in child && child.nodeName === "#text" ? child.value : ""))
    .join("");
}

/** The largest side in a `sizes` value (`"32x32 180x180"`); `any` is unsized. */
export function largestDeclaredSize(sizes: string | undefined) {
  if (!sizes) return undefined;
  let best: number | undefined;
  for (const token of sizes.toLowerCase().split(/\s+/)) {
    const match = /^(\d{1,5})x(\d{1,5})$/.exec(token);
    if (!match) continue;
    const side = Math.max(Number(match[1]), Number(match[2]));
    if (best === undefined || side > best) best = side;
  }
  return best;
}

function resolveHttp(href: string | undefined, base: string) {
  const value = href?.trim();
  if (!value || value.length > MAX_URL_LENGTH) return undefined;
  try {
    const url = new URL(value, base);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function findHead(root: { childNodes?: ChildNode[] }): Element | undefined {
  for (const node of children(root)) {
    if (!isElement(node)) continue;
    if (node.tagName === "head") return node;
    if (node.tagName === "html") {
      const head = findHead(node);
      if (head) return head;
    }
  }
  return undefined;
}

/** The icon declarations, manifest link and title of one fetched page. */
export function extractHead(html: string, pageUrl: string): HeadSignals {
  const document = parse(html);
  const head = findHead(document);
  const signals: HeadSignals = { icons: [] };
  if (!head) return signals;
  let seen = 0;
  for (const node of children(head)) {
    if (!isElement(node)) continue;
    if (node.tagName === "title" && signals.title === undefined) {
      signals.title = textOf(node)
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, MAX_TITLE_LENGTH);
      continue;
    }
    if (node.tagName !== "link") continue;
    if (++seen > MAX_DECLARATIONS) break;
    const rels = (attr(node, "rel") ?? "").toLowerCase().split(/\s+/);
    const url = resolveHttp(attr(node, "href"), pageUrl);
    if (!url) continue;
    if (rels.includes("manifest")) {
      signals.manifestUrl ??= url;
      continue;
    }
    const rel: HeadIconRel | undefined = rels.includes("mask-icon")
      ? "mask-icon"
      : rels.includes("apple-touch-icon") ||
          rels.includes("apple-touch-icon-precomposed")
        ? "apple-touch-icon"
        : rels.includes("icon")
          ? "icon"
          : undefined;
    if (!rel) continue;
    const type = attr(node, "type")?.trim().toLowerCase();
    signals.icons.push({
      rel,
      url,
      size: largestDeclaredSize(attr(node, "sizes")),
      ...(type ? { type } : {}),
    });
  }
  return signals;
}

/**
 * The `icons` of a web-app manifest, resolved against the manifest's address.
 * Anything that is not a JSON object with an `icons` array yields none;
 * monochrome-only icons are skipped (they are masks, not logos).
 */
export function extractManifestIcons(
  json: string,
  manifestUrl: string,
): DeclaredIcon[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const icons = (parsed as { icons?: unknown } | null)?.icons;
  if (!Array.isArray(icons)) return [];
  const out: DeclaredIcon[] = [];
  for (const entry of icons.slice(0, MAX_DECLARATIONS)) {
    if (!entry || typeof entry !== "object") continue;
    const { src, sizes, type, purpose } = entry as Record<string, unknown>;
    if (typeof src !== "string") continue;
    if (typeof purpose === "string" && purpose.trim().toLowerCase() === "monochrome") {
      continue;
    }
    const url = resolveHttp(src, manifestUrl);
    if (!url) continue;
    const mime = typeof type === "string" ? type.trim().toLowerCase() : "";
    out.push({
      rel: "manifest-icon",
      url,
      size: largestDeclaredSize(typeof sizes === "string" ? sizes : undefined),
      ...(mime ? { type: mime } : {}),
    });
  }
  return out;
}

// Titles only a parking or for-sale page carries. Phrases that legitimate
// pages use too ("coming soon", "under construction") are not among them.
const PARKED_TITLE =
  /\b[a-z\d-]+\.[a-z]{2,}(?:\.[a-z]{2})? (?:is|may be) for sale\b|\b(?:parked|domain (?:is |may be |name )?for sale|for sale:|buy this domain|this domain (?:is|may be) (?:available|for sale)|domain (?:has )?expired|hugedomains|afternic)\b/i;
// Titles of a bot-challenge interstitial.
const CHALLENGE_TITLE =
  /^(?:just a moment\.{0,3}|attention required! \| cloudflare|checking your browser|verify you are (?:a )?human|are you a robot\??|one more step)$|\bddos protection by\b/i;

export type PageSignal = "parked" | "challenge";

/**
 * Whether a fetched page is a parking/for-sale page or a bot-challenge page,
 * from its title and response only. Such a page's icons are the registrar's
 * or the CDN's, not the product's. A rate limit (429) is not a challenge: the
 * caller defers it.
 */
export function classifyPage(input: {
  status: number;
  title?: string;
  headers: Record<string, string>;
}): PageSignal | undefined {
  if (
    input.headers["cf-mitigated"] === "challenge" ||
    (input.status === 403 &&
      /cloudflare|sucuri|akamai/i.test(input.headers.server ?? "")) ||
    (input.title && CHALLENGE_TITLE.test(input.title))
  ) {
    return "challenge";
  }
  if (input.title && PARKED_TITLE.test(input.title)) return "parked";
  return undefined;
}
