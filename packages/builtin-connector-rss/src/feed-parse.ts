import { XMLParser, XMLValidator } from "fast-xml-parser";
import { canonicalLink, itemIdentity } from "./feed-identity";
import { htmlToText } from "./html-text";
import { FEED_MAX_BODY_BYTES, FEED_MAX_ITEMS } from "./limits";

export type ParsedFeedItem = {
  externalId: string;
  title: string;
  link: string | null;
  author: string | null;
  publishedAt: Date | null;
  updatedAt: Date | null;
  text: string;
};

export type ParsedFeed = {
  title: string;
  items: ParsedFeedItem[];
  truncated: boolean;
};

/** The document is not an RSS 2.0 or Atom 1.0 feed, or is too hostile to read.
 * The message is fixed: it never repeats document content. */
export class FeedParseError extends Error {
  readonly reason = "feed_not_a_feed" as const;

  constructor() {
    super("The response is not an RSS 2.0 or Atom 1.0 feed.");
    this.name = "FeedParseError";
  }
}

/**
 * Parser limits. Any `<!ENTITY` is rejected before parsing, so only the five
 * predefined XML entities and numeric references ever expand, and each
 * expansion is no longer than its reference. A body is at most
 * {@link FEED_MAX_BODY_BYTES} bytes, so neither the number of references nor
 * the expanded length can exceed it: these ceilings never reject an honest
 * feed, and the ceiling on work is the body size, not the markup. The DOCTYPE
 * entity limits are pinned to the library minimum as a second line of defence.
 */
const PROCESS_ENTITIES = {
  enabled: true,
  maxEntityCount: 1,
  maxEntitySize: 1,
  maxTotalExpansions: FEED_MAX_BODY_BYTES,
  maxExpandedLength: FEED_MAX_BODY_BYTES,
} as const;

/** Deepest element nesting accepted (the library throws beyond it, in time
 * linear in the depth reached). Real feeds, XHTML content included, stay far
 * below this. */
const MAX_NESTED_TAGS = 100;

/** Elements that may repeat and are therefore always parsed as arrays. */
const ARRAY_TAGS = new Set(["item", "entry", "link", "author"]);

const ENTITY_DECLARATION = /<!ENTITY/i;

type Node = Record<string, unknown>;

const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** First element of a possibly repeated value. */
function first(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

/** Text content of an element: a plain string, a `#text` node, or (for XHTML
 * content) every string beneath it. Depth is bounded by the parser. */
function textOf(value: unknown): string {
  const node = first(value);
  if (typeof node === "string") return node;
  if (typeof node === "number" || typeof node === "boolean")
    return String(node);
  if (!isNode(node)) return "";
  const own = node["#text"];
  if (typeof own === "string") return own;
  const parts: string[] = [];
  for (const [key, child] of Object.entries(node)) {
    if (key.startsWith("@_")) continue;
    const children = Array.isArray(child) ? child : [child];
    for (const entry of children) {
      const text = textOf(entry).trim();
      if (text !== "") parts.push(text);
    }
  }
  return parts.join(" ");
}

const attr = (value: unknown, name: string): string | null => {
  const node = first(value);
  if (!isNode(node)) return null;
  const found = node[`@_${name}`];
  return typeof found === "string" ? found : null;
};

const collapse = (value: string): string => value.replace(/\s+/g, " ").trim();

/** Titles are plain text unless the feed says the element holds markup. */
function titleOf(value: unknown): string {
  const text = textOf(value);
  const type = attr(value, "type");
  return type === "html" || type === "xhtml"
    ? collapse(htmlToText(text))
    : collapse(text);
}

/** First non-empty body among the candidates, reduced to plain text. */
function bodyOf(candidates: unknown[]): string {
  for (const candidate of candidates) {
    const raw = textOf(candidate);
    if (raw.trim() === "") continue;
    return attr(candidate, "type") === "text" ? raw.trim() : htmlToText(raw);
  }
  return "";
}

function dateOf(value: unknown): Date | null {
  const text = textOf(value).trim();
  if (text === "") return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** An http(s) URL as written (trimmed), or null. */
function linkOf(raw: string | null): string | null {
  if (raw === null) return null;
  const value = raw.trim();
  return canonicalLink(value) === null ? null : value;
}

function atomLink(value: unknown): string | null {
  const links = Array.isArray(value)
    ? value
    : value === undefined
      ? []
      : [value];
  let fallback: string | null = null;
  for (const link of links) {
    const href = attr(link, "href");
    if (href === null) continue;
    const rel = attr(link, "rel");
    if (rel === null || rel === "alternate") return linkOf(href);
    fallback ??= linkOf(href);
  }
  return fallback;
}

function authorOf(value: unknown): string | null {
  const author = first(value);
  const name = isNode(author) ? textOf(author["name"]) : textOf(author);
  const trimmed = collapse(name);
  return trimmed === "" ? null : trimmed;
}

type RawItem = {
  guid: string | null;
  title: string;
  link: string | null;
  author: string | null;
  publishedAt: Date | null;
  updatedAt: Date | null;
  node: Node;
  atom: boolean;
};

function readItem(
  node: Node,
  atom: boolean,
  feedAuthor: string | null,
): RawItem {
  if (atom) {
    return {
      guid: textOf(node["id"]).trim() || null,
      title: titleOf(node["title"]),
      link: atomLink(node["link"]),
      author: authorOf(node["author"]) ?? feedAuthor,
      publishedAt: dateOf(node["published"]),
      updatedAt: dateOf(node["updated"]),
      node,
      atom,
    };
  }
  const link = Array.isArray(node["link"]) ? node["link"] : [node["link"]];
  return {
    guid: textOf(node["guid"]).trim() || null,
    title: titleOf(node["title"]),
    link: linkOf(
      link.map((entry) => textOf(entry)).find((t) => t.trim() !== "") ?? null,
    ),
    author: collapse(textOf(node["dc:creator"])) || authorOf(node["author"]),
    publishedAt: dateOf(node["pubDate"] ?? node["dc:date"]),
    updatedAt: null,
    node,
    atom,
  };
}

const identityOf = (item: RawItem): string =>
  itemIdentity({
    guid: item.guid,
    link: item.link,
    title: item.title,
    date: item.publishedAt ?? item.updatedAt,
  });

function textFor(item: RawItem): string {
  return item.atom
    ? bodyOf([item.node["content"], item.node["summary"]])
    : bodyOf([item.node["content:encoded"], item.node["description"]]);
}

function parseDocument(xml: string): unknown {
  const source = xml.replace(/^﻿/, "").trimStart();
  if (ENTITY_DECLARATION.test(source)) throw new FeedParseError();
  if (XMLValidator.validate(source) !== true) throw new FeedParseError();
  try {
    return new XMLParser({
      ignoreAttributes: false,
      parseTagValue: false,
      parseAttributeValue: false,
      maxNestedTags: MAX_NESTED_TAGS,
      processEntities: PROCESS_ENTITIES,
      isArray: (name, _path, _leaf, isAttribute) =>
        !isAttribute && ARRAY_TAGS.has(name),
    }).parse(source);
  } catch {
    // Depth and entity limits surface as library errors whose messages quote
    // the document; none of that is passed on.
    throw new FeedParseError();
  }
}

/**
 * Parses an RSS 2.0 or Atom 1.0 document. Anything else (RSS 1.0/RDF, HTML,
 * malformed or hostile XML) throws {@link FeedParseError}. Items keep
 * document order, duplicates by identity keep the first, and at most
 * `maxItems` are returned (`truncated` says more unique items followed).
 */
export function parseFeed(
  xml: string,
  options: { maxItems?: number } = {},
): ParsedFeed {
  const maxItems = options.maxItems ?? FEED_MAX_ITEMS;
  const document = parseDocument(xml);
  if (!isNode(document)) throw new FeedParseError();

  let title: string;
  let rawItems: unknown[];
  let atom: boolean;
  let feedAuthor: string | null = null;

  const rss = document["rss"];
  const feed = document["feed"];
  if (isNode(rss)) {
    const version = attr(rss, "version");
    const channel = rss["channel"];
    if (
      (version !== null && !/^2(\.|$)/.test(version.trim())) ||
      !isNode(channel)
    ) {
      throw new FeedParseError();
    }
    atom = false;
    title = titleOf(channel["title"]);
    rawItems = Array.isArray(channel["item"]) ? channel["item"] : [];
  } else if (isNode(feed)) {
    atom = true;
    title = titleOf(feed["title"]);
    feedAuthor = authorOf(feed["author"]);
    rawItems = Array.isArray(feed["entry"]) ? feed["entry"] : [];
  } else {
    throw new FeedParseError();
  }

  const seen = new Set<string>();
  const items: ParsedFeedItem[] = [];
  let truncated = false;
  for (const raw of rawItems) {
    if (!isNode(raw)) continue;
    const item = readItem(raw, atom, feedAuthor);
    const externalId = identityOf(item);
    if (seen.has(externalId)) continue;
    if (items.length >= maxItems) {
      truncated = true;
      break;
    }
    seen.add(externalId);
    items.push({
      externalId,
      title: item.title,
      link: item.link,
      author: item.author,
      publishedAt: item.publishedAt,
      updatedAt: item.updatedAt,
      text: textFor(item),
    });
  }
  return { title, items, truncated };
}
