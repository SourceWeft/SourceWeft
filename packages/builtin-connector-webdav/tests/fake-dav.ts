import type { ConnectorPublicFetchScope } from "@sourceweft/contracts/capability-host-services";
import { toExternalId } from "../src/paths";

/**
 * An in-memory fake WebDAV server behind a fake `fetch`. A tree is a map of
 * decoded collection paths (each with a trailing slash, the root being `"/"`)
 * to their direct child folders and files. The fake answers PROPFIND with real
 * 207 multistatus XML (hrefs are absolute paths under the endpoint, each
 * segment percent-encoded) and GET with the file's bytes and headers. A
 * `status` map forces a raw HTTP status for a given canonical path (no trailing
 * slash, `"/"` for the root), to exercise 401/403/404.
 */
export type FileSpec = {
  size?: number;
  etag?: string | null;
  lastModified?: string;
  contentType?: string;
  body?: string;
};

export type CollectionSpec = {
  folders?: string[];
  files?: Record<string, FileSpec>;
};

export type FakeDavSpec = {
  endpoint: URL;
  collections: Record<string, CollectionSpec>;
  status?: Record<string, number>;
  /** Raw hrefs a (possibly hostile) server appends to a collection's depth-1
   * listing, keyed by collection key ("/", "/a/b/"). Each is returned as a
   * collection entry exactly as written — used to list parents, siblings, paths
   * outside the root, lookalikes and encoded traversal. */
  rogueChildren?: Record<string, string[]>;
};

const escapeXml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** An absolute-path href for a decoded relative path under the endpoint. */
function hrefFor(
  endpoint: URL,
  relPath: string,
  isCollection: boolean,
): string {
  const segments = relPath
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => encodeURIComponent(segment));
  const trailing = isCollection && segments.length > 0 ? "/" : "";
  return `${endpoint.pathname}${segments.join("/")}${trailing}`;
}

function collectionResponse(endpoint: URL, relPath: string): string {
  const href = hrefFor(endpoint, relPath, true);
  return (
    `<d:response><d:href>${href}</d:href><d:propstat><d:prop>` +
    `<d:resourcetype><d:collection/></d:resourcetype>` +
    `</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
  );
}

function fileResponse(
  endpoint: URL,
  parentPath: string,
  name: string,
  file: FileSpec,
): string {
  const relPath = `${parentPath}${name}`;
  const href = hrefFor(endpoint, relPath, false);
  const props: string[] = ["<d:resourcetype/>"];
  if (file.size !== undefined) {
    props.push(`<d:getcontentlength>${file.size}</d:getcontentlength>`);
  }
  if (file.etag) props.push(`<d:getetag>${escapeXml(file.etag)}</d:getetag>`);
  if (file.lastModified) {
    props.push(
      `<d:getlastmodified>${escapeXml(file.lastModified)}</d:getlastmodified>`,
    );
  }
  if (file.contentType) {
    props.push(
      `<d:getcontenttype>${escapeXml(file.contentType)}</d:getcontenttype>`,
    );
  }
  return (
    `<d:response><d:href>${href}</d:href><d:propstat><d:prop>` +
    props.join("") +
    `</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
  );
}

/** A collection response for a raw href exactly as supplied (hostile input). */
function rawCollectionResponse(href: string): string {
  return (
    `<d:response><d:href>${escapeXml(href)}</d:href><d:propstat><d:prop>` +
    `<d:resourcetype><d:collection/></d:resourcetype>` +
    `</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
  );
}

function multistatus(responses: string[]): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<d:multistatus xmlns:d="DAV:">${responses.join("")}</d:multistatus>`
  );
}

/** Canonical path of a request URL ("/", "/Docs", "/Docs/a.txt"). */
function canonical(endpoint: URL, url: string): string | null {
  return toExternalId(endpoint, url);
}

/** The collection key ("/", "/Docs/") a canonical collection path maps to. */
function collectionKey(canonicalPath: string): string {
  return canonicalPath === "/" ? "/" : `${canonicalPath}/`;
}

export function buildFakeDav(spec: FakeDavSpec): typeof fetch {
  const { endpoint, collections, status = {} } = spec;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const canonicalPath = canonical(endpoint, url);
    if (canonicalPath === null) {
      return new Response("off endpoint", { status: 400 });
    }
    const forced = status[canonicalPath];
    if (forced !== undefined) {
      return new Response("forced", { status: forced });
    }

    if (method === "PROPFIND") {
      const key = collectionKey(canonicalPath);
      const collection = collections[key];
      if (!collection) return new Response("not found", { status: 404 });
      const depth = new Headers(init?.headers).get("depth") ?? "0";
      const responses = [collectionResponse(endpoint, canonicalPath)];
      if (depth === "1") {
        for (const folder of collection.folders ?? []) {
          responses.push(collectionResponse(endpoint, `${key}${folder}`));
        }
        for (const [name, file] of Object.entries(collection.files ?? {})) {
          responses.push(fileResponse(endpoint, key, name, file));
        }
        for (const href of spec.rogueChildren?.[key] ?? []) {
          responses.push(rawCollectionResponse(href));
        }
      }
      return new Response(multistatus(responses), {
        status: 207,
        headers: { "content-type": "application/xml; charset=utf-8" },
      });
    }

    if (method === "GET") {
      const segments = canonicalPath.split("/").filter((s) => s !== "");
      const name = segments.pop();
      const parentKey = segments.length === 0 ? "/" : `/${segments.join("/")}/`;
      const file = name ? collections[parentKey]?.files?.[name] : undefined;
      if (!file) return new Response("not found", { status: 404 });
      const headers: Record<string, string> = {};
      if (file.etag) headers.etag = file.etag;
      if (file.lastModified) headers["last-modified"] = file.lastModified;
      if (file.contentType) headers["content-type"] = file.contentType;
      if (file.size !== undefined) {
        headers["content-length"] = String(file.size);
      }
      return new Response(file.body ?? "", { status: 200, headers });
    }

    if (method === "OPTIONS") {
      return new Response(null, { status: 200, headers: { dav: "1, 2" } });
    }

    return new Response("method not allowed", { status: 405 });
  }) as typeof fetch;
}

/** A credentialed-fetch harness: counts scopes/closes and captures warnings. */
export function fakeHarness(fetchImpl: typeof fetch) {
  const state = { scopes: 0, closes: 0 };
  const warnings: Array<{ message: string; meta?: Record<string, unknown> }> =
    [];
  const credentialedFetch = (): ConnectorPublicFetchScope => {
    state.scopes += 1;
    return {
      fetch: fetchImpl,
      close: async () => {
        state.closes += 1;
      },
    };
  };
  const logger = {
    warn(message: string, meta?: Record<string, unknown>) {
      warnings.push({ message, meta });
    },
  };
  return { credentialedFetch, logger, state, warnings };
}
