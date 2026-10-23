import { createHash } from "node:crypto";
import {
  isPublicStorageConfigured,
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

export function mcpIconStorageKey(input: {
  domain: string;
  bytes: Buffer;
  contentType: string;
}) {
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
