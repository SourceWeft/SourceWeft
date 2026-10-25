import type { MarketMcpManifest } from "@sourceweft/market-sdk";

const GENERIC_KEY_TOKENS = new Set(["mcp", "server", "servers"]);
const MAX_KEY_LENGTH = 40;

function keyTokens(value: string) {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token && !GENERIC_KEY_TOKENS.has(token));
}

/** Four base-36 characters of an FNV-1a hash: stable for an identifier. */
function stableSuffix(identifier: string) {
  let hash = 0x811c9dc5;
  for (const char of identifier) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(4, "0").slice(-4);
}

/**
 * The key a client config files the server under: the display name's slug
 * (`Notion` → `notion`), not the identifier's last segment, which for
 * `com.notion/mcp` is `mcp` and would collide with every other such server.
 * Generic words (mcp, server) are dropped; a name that is nothing but those,
 * or has no letters, falls back to the identifier's tokens with a suffix
 * derived from the identifier, so the key stays the same for the same server
 * and differs between servers. Collision with a config the user already has
 * is for the installer to handle.
 */
export function mcpClientConfigKey(manifest: {
  identifier: string;
  name?: string | null;
}) {
  const named = keyTokens(manifest.name ?? "").join("-");
  if (named) return named.slice(0, MAX_KEY_LENGTH).replace(/-+$/, "");
  const fallback = keyTokens(manifest.identifier.replace(/\//g, " ")).join("-");
  return `${(fallback || "server").slice(0, MAX_KEY_LENGTH - 5).replace(/-+$/, "")}-${stableSuffix(manifest.identifier)}`;
}

function authHeaders(auth: MarketMcpManifest["auth"]) {
  switch (auth.type) {
    case "bearer":
      return { [auth.headerName ?? "Authorization"]: "Bearer <YOUR_TOKEN>" };
    case "api_key_header":
      return { [auth.headerName ?? "X-API-Key"]: "<YOUR_API_KEY>" };
    case "custom_headers": {
      const names = auth.allowedHeaderNames.length
        ? auth.allowedHeaderNames
        : auth.headerName
          ? [auth.headerName]
          : [];
      return Object.fromEntries(names.map((name) => [name, "<VALUE>"]));
    }
    default:
      // OAuth is negotiated by the client at connect time; no static header.
      return {};
  }
}

/**
 * Generic `mcpServers` client config for a remote server, with credential
 * placeholders only. Returns null for STDIO servers: the manifest carries no
 * launch command, so there is nothing truthful to print.
 */
export function remoteMcpClientConfig(manifest: MarketMcpManifest) {
  if (manifest.transport === "stdio" || !manifest.endpointUrl) {
    return null;
  }
  const headers = authHeaders(manifest.auth);
  const server = {
    type:
      manifest.transport === "streamable_http" ? "http" : "sse",
    url: manifest.endpointUrl,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
  return JSON.stringify(
    { mcpServers: { [mcpClientConfigKey(manifest)]: server } },
    null,
    2,
  );
}
