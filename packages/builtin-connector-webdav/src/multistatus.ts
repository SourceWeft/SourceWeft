import { XMLParser, XMLValidator } from "fast-xml-parser";
import { WebDavError } from "./errors";
import { MAX_MULTISTATUS_BYTES } from "./limits";

export type DavEntry = {
  /** The `href` exactly as the server wrote it (percent-encoded, absolute or
   * absolute-path). Turn it into a path with `toExternalId`. */
  href: string;
  isCollection: boolean;
  etag: string | null;
  lastModified: Date | null;
  contentLength: number | null;
  contentType: string | null;
};

/**
 * Parser limits. Any `<!ENTITY` is rejected before parsing, so only the five
 * predefined XML entities and numeric references ever expand, and each
 * expansion is no longer than its reference. The document is at most
 * {@link MAX_MULTISTATUS_BYTES} bytes, so neither the number of references nor
 * the expanded length can exceed it. The DOCTYPE entity limits are pinned to
 * the library minimum as a second line of defence.
 */
const PROCESS_ENTITIES = {
  enabled: true,
  maxEntityCount: 1,
  maxEntitySize: 1,
  maxTotalExpansions: MAX_MULTISTATUS_BYTES,
  maxExpandedLength: MAX_MULTISTATUS_BYTES,
} as const;

/** Deepest element nesting accepted. A multistatus nests five or six levels. */
const MAX_NESTED_TAGS = 32;

/** Elements that may repeat and are therefore always parsed as arrays. */
const ARRAY_TAGS = new Set(["response", "propstat"]);

const ENTITY_DECLARATION = /<!ENTITY/i;

type Node = Record<string, unknown>;

const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const first = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

function text(value: unknown): string | null {
  const node = first(value);
  if (typeof node === "string") return node.trim() || null;
  if (typeof node === "number" || typeof node === "boolean") {
    return String(node);
  }
  return null;
}

function parseDocument(xml: string): Node {
  if (
    typeof xml !== "string" ||
    Buffer.byteLength(xml, "utf8") > MAX_MULTISTATUS_BYTES
  ) {
    throw new WebDavError("WEBDAV_BAD_RESPONSE");
  }
  const source = xml.replace(/^﻿/, "").trimStart();
  if (source === "" || ENTITY_DECLARATION.test(source)) {
    throw new WebDavError("WEBDAV_BAD_RESPONSE");
  }
  if (XMLValidator.validate(source) !== true) {
    throw new WebDavError("WEBDAV_BAD_RESPONSE");
  }
  try {
    const parsed: unknown = new XMLParser({
      ignoreAttributes: true,
      removeNSPrefix: true,
      parseTagValue: false,
      maxNestedTags: MAX_NESTED_TAGS,
      processEntities: PROCESS_ENTITIES,
      isArray: (name) => ARRAY_TAGS.has(name),
    }).parse(source);
    if (!isNode(parsed)) throw new WebDavError("WEBDAV_BAD_RESPONSE");
    return parsed;
  } catch {
    // Depth and entity limits surface as library errors whose messages quote
    // the document; none of that is passed on.
    throw new WebDavError("WEBDAV_BAD_RESPONSE");
  }
}

/** `HTTP/1.1 200 OK` style status line: true for 2xx, and when absent. */
function isSuccessStatus(value: unknown): boolean {
  const line = text(value);
  if (line === null) return true;
  const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/i.exec(line);
  return match === null ? false : match[1]!.startsWith("2");
}

function contentLengthOf(value: unknown): number | null {
  const raw = text(value);
  if (raw === null || !/^\d{1,15}$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function dateOf(value: unknown): Date | null {
  const raw = text(value);
  if (raw === null) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Merges the properties of every 2xx propstat; the first value wins. */
function propertiesOf(response: Node): Node {
  const merged: Node = {};
  const propstats = Array.isArray(response["propstat"])
    ? response["propstat"]
    : [];
  for (const propstat of propstats) {
    if (!isNode(propstat) || !isSuccessStatus(propstat["status"])) continue;
    const prop = propstat["prop"];
    if (!isNode(prop)) continue;
    for (const [name, value] of Object.entries(prop)) {
      if (!(name in merged)) merged[name] = value;
    }
  }
  return merged;
}

/**
 * Parses a WebDAV 207 multistatus into entries. Properties a server could not
 * supply (404 propstat, missing, malformed) read as null. A response without
 * an href is skipped; duplicate hrefs keep the first. A response that names a
 * resource (an href) but carries no propstat at all is an RFC 4918 per-resource
 * error (a bare `<status>` such as 403 or 423): it yields no entry and, when a
 * {@link PropfindStats}-shaped `stats` is passed, increments `stats.dropped` so
 * the caller can tell the listing was not fully described. Malformed, oversized,
 * hostile or non-multistatus documents throw a fixed `WEBDAV_BAD_RESPONSE`.
 */
export function parseMultistatus(
  xml: string,
  stats?: { dropped: number },
): DavEntry[] {
  const document = parseDocument(xml);
  if (!("multistatus" in document))
    throw new WebDavError("WEBDAV_BAD_RESPONSE");
  const multistatus = document["multistatus"];
  if (multistatus === "") return [];
  if (!isNode(multistatus)) throw new WebDavError("WEBDAV_BAD_RESPONSE");
  const responses = Array.isArray(multistatus["response"])
    ? multistatus["response"]
    : [];

  const seen = new Set<string>();
  const entries: DavEntry[] = [];
  for (const response of responses) {
    if (!isNode(response)) continue;
    const href = text(response["href"]);
    if (href === null || seen.has(href)) continue;
    if (!Array.isArray(response["propstat"])) {
      // A named resource the server reported but did not describe: a
      // per-resource error (403/423) the listing could not fully cover.
      if (stats) stats.dropped += 1;
      continue;
    }
    seen.add(href);
    const props = propertiesOf(response);
    const resourcetype = props["resourcetype"];
    entries.push({
      href,
      isCollection: isNode(resourcetype) && "collection" in resourcetype,
      etag: text(props["getetag"]),
      lastModified: dateOf(props["getlastmodified"]),
      contentLength: contentLengthOf(props["getcontentlength"]),
      contentType: text(props["getcontenttype"]),
    });
  }
  return entries;
}
