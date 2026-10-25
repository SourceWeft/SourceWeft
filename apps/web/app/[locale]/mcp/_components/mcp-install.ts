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

/** Clients whose config shape and variable syntax this file knows. */
export type McpClientId = "claude-code" | "cursor" | "generic";

export type McpClientConfigOptions = {
  client?: McpClientId;
  /**
   * The name of an environment variable that holds the credential. The
   * config then refers to it the way `client` spells it instead of carrying
   * a placeholder; the value itself never passes through here.
   */
  keyEnv?: string;
};

const HEADER_NAME = /^[\w-]{1,100}$/;

/** How `client` refers to an environment variable inside its config file. */
function envReference(client: McpClientId, name: string) {
  return client === "cursor" ? `\${env:${name}}` : `\${${name}}`;
}

function credentialValue(
  client: McpClientId,
  keyEnv: string | undefined,
  placeholder: string,
  prefix = "",
) {
  return keyEnv === undefined
    ? `${prefix}${placeholder}`
    : `${prefix}${envReference(client, keyEnv)}`;
}

function authHeaders(
  auth: MarketMcpManifest["auth"],
  client: McpClientId,
  keyEnv: string | undefined,
): Record<string, string> {
  switch (auth.type) {
    case "bearer":
      return {
        [auth.headerName ?? "Authorization"]: credentialValue(
          client,
          keyEnv,
          "<YOUR_TOKEN>",
          "Bearer ",
        ),
      };
    case "api_key_header":
      return {
        [auth.headerName ?? "X-API-Key"]: credentialValue(
          client,
          keyEnv,
          "<YOUR_API_KEY>",
        ),
      };
    case "custom_headers": {
      const names = auth.allowedHeaderNames.length
        ? auth.allowedHeaderNames
        : auth.headerName
          ? [auth.headerName]
          : [];
      // One variable cannot stand for several different secrets: with more
      // than one header the values stay placeholders to fill in by hand.
      const single = names.length === 1 ? keyEnv : undefined;
      return Object.fromEntries(
        names.map((name) => [
          name,
          credentialValue(client, single, "<VALUE>"),
        ]),
      );
    }
    default:
      // OAuth is negotiated by the client at connect time; no static header.
      return {};
  }
}

/**
 * The `mcpServers` config for a remote server as an object. Credentials are
 * placeholders, or, with `keyEnv`, a reference to that environment variable.
 * Null for STDIO servers: the manifest carries no launch command, so there
 * is nothing truthful to print. A header name that is not a plain token is
 * left out rather than echoed.
 */
export function remoteMcpClientConfigObject(
  manifest: MarketMcpManifest,
  options: McpClientConfigOptions = {},
) {
  if (manifest.transport === "stdio" || !manifest.endpointUrl) {
    return null;
  }
  const client = options.client ?? "generic";
  const headers = Object.fromEntries(
    Object.entries(authHeaders(manifest.auth, client, options.keyEnv)).filter(
      ([name]) => HEADER_NAME.test(name),
    ),
  );
  const server = {
    // Cursor infers the transport from the URL and takes no `type`.
    ...(client === "cursor"
      ? {}
      : { type: manifest.transport === "streamable_http" ? "http" : "sse" }),
    url: manifest.endpointUrl,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
  return { mcpServers: { [mcpClientConfigKey(manifest)]: server } };
}

/**
 * Generic `mcpServers` client config for a remote server, as JSON text.
 * Returns null for STDIO servers (see `remoteMcpClientConfigObject`).
 */
export function remoteMcpClientConfig(
  manifest: MarketMcpManifest,
  options: McpClientConfigOptions = {},
) {
  const config = remoteMcpClientConfigObject(manifest, options);
  return config ? JSON.stringify(config, null, 2) : null;
}
