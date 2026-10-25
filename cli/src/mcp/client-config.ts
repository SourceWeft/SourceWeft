import type { McpManifestView } from "../registry/schema";

/**
 * The `mcpServers` config for a catalog server, as `mcp install` prints and
 * writes it. This is the same builder as the website's install dialog and
 * install guide (`apps/web/app/[locale]/mcp/_components/mcp-install.ts`); the
 * CLI is published on its own and cannot import the web app, so it keeps a
 * copy and `test/mcp-client-config.test.ts` runs both over the same manifests
 * and fails when they differ.
 */

export type McpClientId = "claude-code" | "cursor" | "generic";
export const MCP_CLIENT_IDS: readonly McpClientId[] = [
  "claude-code",
  "cursor",
  "generic",
];

/**
 * A conventional environment variable name: upper case, digits and
 * underscores. A pasted API key (`sk-…`, `ghp_Ab…`) is mixed case or has
 * other characters, so it is refused here instead of being echoed into a
 * config file as if it were a name.
 */
export const ENV_VAR_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const HEADER_NAME = /^[\w-]{1,100}$/;
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

/** The header names a custom-headers server accepts. */
export function customHeaderNames(auth: McpManifestView["auth"]): string[] {
  return auth.allowedHeaderNames.length
    ? auth.allowedHeaderNames
    : auth.headerName
      ? [auth.headerName]
      : [];
}

function authHeaders(
  auth: McpManifestView["auth"],
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
      const names = customHeaderNames(auth);
      // One variable cannot stand for several different secrets.
      const single = names.length === 1 ? keyEnv : undefined;
      return Object.fromEntries(
        names.map((name) => [name, credentialValue(client, single, "<VALUE>")]),
      );
    }
    default:
      // OAuth is negotiated by the client at connect time; no static header.
      return {};
  }
}

/** Transports with a URL to print; `streamable_http` is `http`, the rest `sse`. */
export const REMOTE_TRANSPORTS: ReadonlySet<string> = new Set([
  "streamable_http",
  "sse",
  "http_sse_compat",
]);

export type McpClientConfig = {
  mcpServers: Record<string, Record<string, unknown>>;
};

/**
 * The config for a remote (Streamable HTTP or one of the SSE kinds) server. Credentials are
 * placeholders or, with `keyEnv`, a reference to that environment variable.
 * Null when the manifest has no remote endpoint to print.
 */
export function buildMcpClientConfig(
  manifest: McpManifestView,
  options: { client: McpClientId; keyEnv?: string },
): McpClientConfig | null {
  if (!REMOTE_TRANSPORTS.has(manifest.transport) || !manifest.endpointUrl) {
    return null;
  }
  const headers = Object.fromEntries(
    Object.entries(
      authHeaders(manifest.auth, options.client, options.keyEnv),
    ).filter(([name]) => HEADER_NAME.test(name)),
  );
  const server = {
    // Cursor infers the transport from the URL and takes no `type`.
    ...(options.client === "cursor"
      ? {}
      : { type: manifest.transport === "streamable_http" ? "http" : "sse" }),
    url: manifest.endpointUrl,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
  return { mcpServers: { [mcpClientConfigKey(manifest)]: server } };
}
