import { createHash } from "node:crypto";
import {
  isPublicStorageConfigured,
  publicObjectExists,
  publicObjectUrl,
  putPublicObject,
  type PublicObjectWriter,
} from "../../../shared/public-storage";
import { imageExtension } from "./favicon";

/**
 * Where fetched favicons live: the public asset bucket, under a key made of
 * the domain and the bytes' hash, so a re-fetch of the same icon writes the
 * same object and a changed icon gets a new URL. Pages reference only this
 * URL, never the favicon service.
 */
export const MCP_ICON_KEY_PREFIX = "market/mcp-icons";

// A lowercase DNS name: labels of alphanumerics and hyphens joined by dots.
// The domain comes from `namespaceDomain`, which only produces these; the
// check keeps anything else out of an object key.
const STORAGE_DOMAIN_RE =
  /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?)+$/;

export function mcpIconStorageKey(input: {
  domain: string;
  bytes: Buffer;
  contentType: string;
}) {
  if (!STORAGE_DOMAIN_RE.test(input.domain)) {
    throw new Error(`Not a storable icon domain: ${input.domain}`);
  }
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  return `${MCP_ICON_KEY_PREFIX}/${input.domain}/${sha256.slice(0, 32)}.${imageExtension(input.contentType)}`;
}

export type McpIconStore = (input: {
  domain: string;
  bytes: Buffer;
  contentType: string;
}) => Promise<{ url: string }>;

/** Whether `storeMcpIcon` has a bucket to write to and a URL to serve from. */
export function canStoreMcpIcons() {
  return isPublicStorageConfigured();
}

export function createMcpIconStore(
  write: PublicObjectWriter = putPublicObject,
): McpIconStore {
  return async (input) => {
    const stored = await write({
      key: mcpIconStorageKey(input),
      body: input.bytes,
      contentType: input.contentType,
      // Content-addressed: the object at this key never changes.
      cacheControl: "public, max-age=31536000, immutable",
    });
    return { url: stored.publicUrl };
  };
}

export const storeMcpIcon: McpIconStore = createMcpIconStore();

/**
 * Candidates of the icon dry-run (Issue #367) are stored by the hash of their
 * bytes alone — `market/mcp-icons/by-hash/<sha256>.<ext>` — so the same image
 * found under several listings or domains is one object, and a URL never
 * changes meaning.
 */
export const MCP_ICON_HASH_KEY_PREFIX = `${MCP_ICON_KEY_PREFIX}/by-hash`;

export type HashedIconStore = (input: {
  sha256: string;
  bytes: Buffer;
  contentType: string;
}) => Promise<{ url: string }>;

export function createHashedIconStore(
  write: PublicObjectWriter = putPublicObject,
  exists: (key: string) => Promise<boolean> = publicObjectExists,
): HashedIconStore {
  return async ({ sha256, bytes, contentType }) => {
    if (!/^[a-f\d]{64}$/.test(sha256)) {
      throw new Error("Not a sha256 digest");
    }
    const key = `${MCP_ICON_HASH_KEY_PREFIX}/${sha256}.${imageExtension(contentType)}`;
    // The key is the content hash: an object that is there is these bytes.
    if (await exists(key)) return { url: publicObjectUrl(key) };
    const stored = await write({
      key,
      body: bytes,
      contentType,
      cacheControl: "public, max-age=31536000, immutable",
    });
    return { url: stored.publicUrl };
  };
}

export const storeHashedMcpIcon: HashedIconStore = createHashedIconStore();
