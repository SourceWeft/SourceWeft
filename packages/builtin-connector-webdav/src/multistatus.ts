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
  /**
   * owncloud/Nextcloud `oc:` properties, read only from an element whose prefix
   * is bound to the owncloud namespace URI `http://owncloud.org/ns` (a
   * prefix-agnostic `fileid` under a foreign namespace is ignored, so a
   * non-Nextcloud server cannot masquerade). A key is present on the entry only
   * when the server returned the corresponding element — so a plain WebDAV entry
   * carries none of them and keeps its historical shape. The value is `null`
   * when the element was returned but empty, or returned a value that failed the
   * flavor-independent sanity check below; consumers that need a uniform "null
   * when absent" read it through a `?? null` (see the flavor's item identity).
   * Filled only when a flavor asks for them via `propfind`'s `extraProps`:
   *  - `fileId` must match {@link OC_FILE_ID_PATTERN} (so it is safe to embed in
   *    an external id and a canonical URL); otherwise it reads as `null`.
   *  - `permissions` is at most {@link MAX_OC_PERMISSIONS_LENGTH} characters and
   *    `ownerId` at most {@link MAX_OC_OWNER_ID_LENGTH}; a longer value reads as
   *    `null`.
   */
  fileId?: string | null;
  permissions?: string | null;
  ownerId?: string | null;
};

/** The owncloud/Nextcloud property namespace. An `oc:` prop counts only when its
 * prefix resolves to this URI. */
const OWNCLOUD_NS = "http://owncloud.org/ns";

/** A Nextcloud file id is a short token of ASCII word characters and hyphens.
 * Anything else (spaces, slashes, markup, an over-long value) is rejected so the
 * id is always safe to use as an external id and inside a canonical URL. */
export const OC_FILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Length caps on the free-text `oc:permissions` / `oc:owner-id` values: a
 * server returning anything longer is not trusted for that property. */
export const MAX_OC_PERMISSIONS_LENGTH = 32;
export const MAX_OC_OWNER_ID_LENGTH = 256;

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

/** The local name of a (possibly namespace-prefixed) element or attribute key. */
function localName(key: string): string {
  const colon = key.indexOf(":");
  return colon === -1 ? key : key.slice(colon + 1);
}

/** The first child value of `node` whose key has the given local name, skipping
 * attribute keys. */
function pickLocal(node: Node, local: string): unknown {
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("@_")) continue;
    if (localName(key) === local) return value;
  }
  return undefined;
}

const asArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : value === undefined ? [] : [value];

/** Collects the `xmlns` / `xmlns:<prefix>` declarations an element carries into
 * a prefix -> URI map (the default namespace is the empty-string key). */
function xmlnsOf(node: Node): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [key, value] of Object.entries(node)) {
    if (typeof value !== "string") continue;
    if (key === "@_xmlns") map[""] = value;
    else if (key.startsWith("@_xmlns:"))
      map[key.slice("@_xmlns:".length)] = value;
  }
  return map;
}

/**
 * A second parse that keeps namespace prefixes and attributes, used only to read
 * the owncloud `oc:` properties with their namespace verified — the primary
 * parse strips prefixes (which is exactly what the standard DAV properties want,
 * since servers use many different prefixes for them). The caller runs this only
 * when the document actually declares the owncloud namespace, so a plain WebDAV
 * response is parsed once and unchanged.
 */
const OC_PARSER = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: false,
  parseTagValue: false,
  maxNestedTags: MAX_NESTED_TAGS,
  processEntities: PROCESS_ENTITIES,
  isArray: (name) => ARRAY_TAGS.has(localName(name)),
});

type OcProps = {
  fileId?: string | null;
  permissions?: string | null;
  ownerId?: string | null;
};

const sanitizeFileId = (value: string | null): string | null =>
  value !== null && OC_FILE_ID_PATTERN.test(value) ? value : null;

const capped = (value: string | null, max: number): string | null =>
  value !== null && value.length <= max ? value : null;

/**
 * Reads the owncloud `oc:fileid` / `oc:permissions` / `oc:owner-id` properties
 * per response href, accepting a property only when its element's prefix is
 * bound to {@link OWNCLOUD_NS}. First value wins (per href and per property),
 * mirroring the primary parse's duplicate-href and first-propstat semantics.
 * Values are sanity-checked ({@link sanitizeFileId}, length caps); a present but
 * unusable value reads as `null`, and a key is set only when the (owncloud)
 * element was present. Any parse failure yields no owncloud data rather than
 * throwing: the primary parse has already validated the document.
 */
function extractOwncloudProps(xml: string): Map<string, OcProps> {
  const out = new Map<string, OcProps>();
  let parsed: unknown;
  try {
    parsed = OC_PARSER.parse(xml);
  } catch {
    return out;
  }
  if (!isNode(parsed)) return out;
  const multistatus = pickLocal(parsed, "multistatus");
  if (!isNode(multistatus)) return out;
  const rootNs = { ...xmlnsOf(parsed), ...xmlnsOf(multistatus) };
  for (const response of asArray(pickLocal(multistatus, "response"))) {
    if (!isNode(response)) continue;
    const href = text(pickLocal(response, "href"));
    if (href === null || out.has(href)) continue;
    const responseNs = { ...rootNs, ...xmlnsOf(response) };
    const oc: OcProps = {};
    for (const propstat of asArray(pickLocal(response, "propstat"))) {
      if (!isNode(propstat)) continue;
      if (!isSuccessStatus(pickLocal(propstat, "status"))) continue;
      const prop = pickLocal(propstat, "prop");
      if (!isNode(prop)) continue;
      const propNs = { ...responseNs, ...xmlnsOf(prop) };
      for (const [key, value] of Object.entries(prop)) {
        if (key.startsWith("@_")) continue;
        const colon = key.indexOf(":");
        const prefix = colon === -1 ? "" : key.slice(0, colon);
        if (propNs[prefix] !== OWNCLOUD_NS) continue;
        const name = localName(key);
        if (name === "fileid" && !("fileId" in oc)) oc.fileId = text(value);
        else if (name === "permissions" && !("permissions" in oc)) {
          oc.permissions = text(value);
        } else if (name === "owner-id" && !("ownerId" in oc)) {
          oc.ownerId = text(value);
        }
      }
    }
    if ("fileId" in oc || "permissions" in oc || "ownerId" in oc) {
      out.set(href, oc);
    }
  }
  return out;
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

  // The owncloud properties are read from a second, namespace-aware parse, but
  // only when the document declares the owncloud namespace at all — so a plain
  // WebDAV response is parsed exactly once and its entries keep their historical
  // shape.
  const ocProps = xml.includes(OWNCLOUD_NS) ? extractOwncloudProps(xml) : null;

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
    const entry: DavEntry = {
      href,
      isCollection: isNode(resourcetype) && "collection" in resourcetype,
      etag: text(props["getetag"]),
      lastModified: dateOf(props["getlastmodified"]),
      contentLength: contentLengthOf(props["getcontentlength"]),
      contentType: text(props["getcontenttype"]),
    };
    // Owncloud properties come from the namespace-verified extraction above. A
    // key is added only when the server returned the (owncloud-namespaced)
    // element, so a plain WebDAV entry is untouched; a present-but-empty or
    // present-but-unusable element reads as null.
    const oc = ocProps?.get(href);
    if (oc) {
      if ("fileId" in oc) entry.fileId = sanitizeFileId(oc.fileId ?? null);
      if ("permissions" in oc) {
        entry.permissions = capped(
          oc.permissions ?? null,
          MAX_OC_PERMISSIONS_LENGTH,
        );
      }
      if ("ownerId" in oc) {
        entry.ownerId = capped(oc.ownerId ?? null, MAX_OC_OWNER_ID_LENGTH);
      }
    }
    entries.push(entry);
  }
  return entries;
}
