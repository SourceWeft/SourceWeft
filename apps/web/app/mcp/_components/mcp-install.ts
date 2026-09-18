import type { MarketMcpManifest } from "@sourceweft/market-sdk";

function serverKey(identifier: string) {
  const tail = identifier.split("/").filter(Boolean).at(-1) ?? identifier;
  return (
    tail
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "mcp-server"
  );
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
    { mcpServers: { [serverKey(manifest.identifier)]: server } },
    null,
    2,
  );
}
