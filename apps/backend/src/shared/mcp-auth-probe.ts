/**
 * What an MCP endpoint says about authentication when sent one
 * unauthenticated `initialize`:
 * - "oauth": a 401 whose `WWW-Authenticate` names protected-resource metadata
 *   (RFC 9728) — the MCP authorization spec's OAuth discovery signal — or,
 *   when it names none, whose well-known protected-resource metadata lists an
 *   authorization server;
 * - "credential": a 401 without either — some credential is required, and the
 *   endpoint does not say which;
 * - "open": anything else (an initialize answer, a redirect, an error page).
 */
export type McpEndpointAuthProbe = "open" | "credential" | "oauth";

/** An icon the server offers in its `serverInfo` (the MCP `Icon` shape). */
export type McpProbeIcon = { src: string; mimeType?: string; sizes?: string[] };

export type McpProbeServerInfo = {
  name: string;
  title?: string;
  version?: string;
  description?: string;
  websiteUrl?: string;
  icons?: McpProbeIcon[];
};

/** What the server said about itself in its `initialize` result, bounded. */
export type McpProbeSelfDescription = {
  serverInfo?: McpProbeServerInfo;
  instructions?: string;
  capabilities?: Record<string, unknown>;
};

/** The human fields of the protected-resource metadata a 401 points at. */
export type McpProbeAuthMetadata = {
  resourceName?: string;
  resourceDocumentation?: string;
};

/**
 * One unauthenticated probe of an endpoint (Issue #367, W1): its auth
 * classification, and what it gave away while being classified.
 * - `selfDescription`: present when `initialize` answered with a result;
 * - `authMetadata`: present when a 401's protected-resource metadata carried
 *   a `resource_name` or an https `resource_documentation`;
 * - `serverCard`: the origin's `/.well-known/mcp/server-card.json` (SEP-1649)
 *   when it serves one, as is.
 * The tools an open endpoint lists are the tool listing's
 * (`shared/mcp-tool-listing.ts`), not the probe's.
 */
export type McpEndpointProbe = {
  result: McpEndpointAuthProbe;
  selfDescription?: McpProbeSelfDescription;
  authMetadata?: McpProbeAuthMetadata;
  serverCard?: Record<string, unknown>;
};

const PROBE_TIMEOUT_MS = 5000;
// Protected-resource metadata and a server card are small documents; the
// endpoint is third-party, so a larger body is not read.
const METADATA_MAX_BYTES = 64 * 1024;
// An `initialize` answer.
const RESPONSE_MAX_BYTES = 256 * 1024;
const PROTOCOL_VERSION = "2025-06-18";
const INITIALIZE_ID = 1;

/**
 * The bounds self-description is kept within (the W1 data contract, plus
 * what keeps a hostile server from filling the catalog): everything stored
 * from one server is third-party JSON served on every public read of it.
 */
export const MCP_PROBE_LIMITS = {
  instructionsBytes: 8 * 1024,
  stringChars: 500,
  urlChars: 2048,
  icons: 5,
  // `capabilities` as serialized JSON; larger is dropped.
  capabilitiesBytes: 4 * 1024,
} as const;

class TooLargeError extends Error {}

/** The body as text, or a throw once it passes `maxBytes`. */
async function readCappedText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new TooLargeError("Response body is too large");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

type JsonRpcMessage = {
  id?: unknown;
  result?: unknown;
  error?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The JSON-RPC messages in an SSE text: every event's `data:` lines. */
function sseMessages(text: string): JsonRpcMessage[] {
  const messages: JsonRpcMessage[] = [];
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) continue;
    try {
      const parsed = JSON.parse(data) as unknown;
      for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
        if (isRecord(message)) messages.push(message);
      }
    } catch {
      // Not JSON (a keep-alive, a partial event still streaming): skip it.
    }
  }
  return messages;
}

function findResponse(messages: JsonRpcMessage[], id: number) {
  return messages.find(
    (message) => String(message.id) === String(id) && "result" in message,
  );
}

/** Where the last complete SSE event in `text` ends; -1 when none does. */
function lastEventBoundary(text: string) {
  const lf = text.lastIndexOf("\n\n");
  const crlf = text.lastIndexOf("\r\n\r\n");
  return Math.max(lf < 0 ? -1 : lf + 2, crlf < 0 ? -1 : crlf + 4);
}

/**
 * The response to request `id` on an SSE stream. A Streamable HTTP server may
 * keep the stream open after its answer, so the read stops as soon as the
 * answer is in; only the events completed since the last chunk are parsed.
 */
async function readSseResult(
  response: Response,
  id: number,
): Promise<Record<string, unknown> | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const decoder = new TextDecoder();
  let buffer = "";
  let size = 0;
  const resultOf = (found: JsonRpcMessage | undefined) =>
    isRecord(found?.result) ? found.result : undefined;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      buffer += decoder.decode();
      return resultOf(findResponse(sseMessages(buffer), id));
    }
    size += value.byteLength;
    if (size > RESPONSE_MAX_BYTES) {
      await reader.cancel();
      throw new TooLargeError("Response body is too large");
    }
    buffer += decoder.decode(value, { stream: true });
    const boundary = lastEventBoundary(buffer);
    if (boundary < 0) continue;
    const found = findResponse(sseMessages(buffer.slice(0, boundary)), id);
    buffer = buffer.slice(boundary);
    if (found) {
      await reader.cancel();
      return resultOf(found);
    }
  }
}

/**
 * The JSON-RPC response to request `id` in `response`, read as plain JSON or
 * as an SSE stream (Streamable HTTP answers either way). Undefined when the
 * status is not a success, the body is not readable, or it holds no result
 * for that id (an error response included).
 */
async function readJsonRpcResult(
  response: Response,
  id: number,
): Promise<Record<string, unknown> | undefined> {
  if (!response.ok) {
    await response.body?.cancel();
    return undefined;
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (/text\/event-stream/i.test(contentType)) {
    return readSseResult(response, id);
  }
  const text = await readCappedText(response, RESPONSE_MAX_BYTES);
  const parsed = JSON.parse(text) as unknown;
  const messages = (Array.isArray(parsed) ? parsed : [parsed]).filter(isRecord);
  const found = findResponse(messages, id);
  return isRecord(found?.result) ? found.result : undefined;
}

function boundedString(value: unknown, maxChars: number) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return Array.from(trimmed).slice(0, maxChars).join("");
}

function boundedBytes(value: unknown, maxBytes: number) {
  if (typeof value !== "string") return undefined;
  let text = value.trim();
  if (!text) return undefined;
  while (Buffer.byteLength(text, "utf8") > maxBytes) {
    const ratio = maxBytes / Buffer.byteLength(text, "utf8");
    text = Array.from(text)
      .slice(0, Math.max(1, Math.floor(Array.from(text).length * ratio)))
      .join("");
  }
  return text;
}

/** A JSON object no larger than `maxBytes` once serialized, else undefined. */
function boundedObject(value: unknown, maxBytes: number) {
  if (!isRecord(value)) return undefined;
  return Buffer.byteLength(JSON.stringify(value), "utf8") <= maxBytes
    ? value
    : undefined;
}

/**
 * An https URL of ordinary length and without credentials in it, normalized;
 * anything else is dropped. A URL is shown or linked, never fetched here.
 */
function httpsUrl(value: unknown) {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (text.length > MCP_PROBE_LIMITS.urlChars) return undefined;
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" || url.username || url.password) {
      return undefined;
    }
    const normalized = url.toString();
    return normalized.length <= MCP_PROBE_LIMITS.urlChars
      ? normalized
      : undefined;
  } catch {
    return undefined;
  }
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

/** `serverInfo` kept within the contract's bounds; undefined without a name. */
function boundedServerInfo(value: unknown): McpProbeServerInfo | undefined {
  if (!isRecord(value)) return undefined;
  const name = boundedString(value.name, MCP_PROBE_LIMITS.stringChars);
  if (!name) return undefined;
  const icons: McpProbeIcon[] = [];
  for (const icon of Array.isArray(value.icons) ? value.icons : []) {
    if (icons.length >= MCP_PROBE_LIMITS.icons) break;
    if (!isRecord(icon)) continue;
    const src = httpsUrl(icon.src);
    if (!src) continue;
    const sizes = Array.isArray(icon.sizes)
      ? icon.sizes.filter((size): size is string => typeof size === "string")
      : undefined;
    icons.push(
      withoutUndefined({
        src,
        mimeType: boundedString(icon.mimeType, 100),
        sizes: sizes && sizes.length > 0 ? sizes.slice(0, 10) : undefined,
      }),
    );
  }
  return withoutUndefined({
    name,
    title: boundedString(value.title, MCP_PROBE_LIMITS.stringChars),
    version: boundedString(value.version, MCP_PROBE_LIMITS.stringChars),
    description: boundedString(value.description, MCP_PROBE_LIMITS.stringChars),
    websiteUrl: httpsUrl(value.websiteUrl),
    icons: icons.length > 0 ? icons : undefined,
  });
}

function selfDescriptionOf(
  result: Record<string, unknown>,
): McpProbeSelfDescription {
  return withoutUndefined({
    serverInfo: boundedServerInfo(result.serverInfo),
    instructions: boundedBytes(
      result.instructions,
      MCP_PROBE_LIMITS.instructionsBytes,
    ),
    capabilities: boundedObject(
      result.capabilities,
      MCP_PROBE_LIMITS.capabilitiesBytes,
    ),
  });
}

/**
 * Send the probe through `fetchImpl`, which the caller scopes to its endpoint
 * policy (an SSRF-checked request scope). Redirects are not followed: the
 * endpoint passed the policy, but a 3xx could bounce the probe to an internal
 * address; a same-origin redirect is simply "not a 401". Network and policy
 * failures of the `initialize` are thrown for the caller to handle; those of
 * the lookups after it (the well-known metadata, the server card) only mean
 * that document was not found — a caller with a request scope checks it for
 * denials afterwards. One time budget covers all of it.
 *
 * Nothing sent carries a credential, and `resource_documentation` is never
 * fetched.
 */
export async function probeMcpEndpointAuth(
  endpointUrl: string,
  fetchImpl: typeof globalThis.fetch,
): Promise<McpEndpointProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const signal = controller.signal;
  try {
    const response = await fetchImpl(endpointUrl, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: INITIALIZE_ID,
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "sourceweft-auth-probe", version: "1" },
        },
      }),
      signal,
    });
    let probe: McpEndpointProbe;
    if (response.status === 401) {
      await response.body?.cancel();
      probe = await classifyChallenge(
        endpointUrl,
        response.headers.get("www-authenticate") ?? "",
        fetchImpl,
        signal,
      );
    } else {
      probe = await describeOpenEndpoint(response);
    }
    const serverCard = await readServerCard(endpointUrl, fetchImpl, signal);
    return withoutUndefined({ ...probe, serverCard });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * An endpoint that did not answer 401 is "open". When its answer is an
 * `initialize` result, keep what it says about itself.
 */
async function describeOpenEndpoint(
  response: Response,
): Promise<McpEndpointProbe> {
  let result: Record<string, unknown> | undefined;
  try {
    result = await readJsonRpcResult(response, INITIALIZE_ID);
  } catch {
    // Not JSON, too large or cut off: an open endpoint that said nothing.
    result = undefined;
  }
  if (!result) return { result: "open" };
  return { result: "open", selfDescription: selfDescriptionOf(result) };
}

/**
 * The RFC 9728 well-known metadata locations for an endpoint: the
 * path-specific one first, then the origin's. Query and fragment are not
 * part of a resource's metadata location.
 */
function protectedResourceMetadataUrls(endpointUrl: string): string[] {
  const url = new URL(endpointUrl);
  const path = url.pathname.replace(/\/+$/, "");
  const root = `${url.origin}/.well-known/oauth-protected-resource`;
  return path ? [`${root}${path}`, root] : [root];
}

/**
 * The metadata location a `WWW-Authenticate` challenge names, when it is on
 * the endpoint's own origin. Another origin is not read: the challenge is
 * the endpoint's word, and the probe's policy was checked for the endpoint.
 */
function challengeMetadataUrl(endpointUrl: string, challenge: string) {
  const named = /\bresource_metadata\s*=\s*"?([^",\s]+)"?/i.exec(
    challenge,
  )?.[1];
  if (!named) return undefined;
  try {
    const url = new URL(named);
    return url.origin === new URL(endpointUrl).origin
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

type ProtectedResourceMetadata = {
  namesAuthorizationServer: boolean;
  authMetadata?: McpProbeAuthMetadata;
};

/**
 * A 401: "oauth" when the challenge names protected-resource metadata, or
 * when the metadata found names an authorization server; "credential"
 * otherwise. The metadata's human fields come along either way.
 */
async function classifyChallenge(
  endpointUrl: string,
  challenge: string,
  fetchImpl: typeof globalThis.fetch,
  signal: AbortSignal,
): Promise<McpEndpointProbe> {
  const named = challengeMetadataUrl(endpointUrl, challenge);
  const locations = [
    ...(named ? [named] : []),
    ...protectedResourceMetadataUrls(endpointUrl).filter(
      (location) => location !== named,
    ),
  ];
  const metadata = await readProtectedResourceMetadata(
    locations,
    fetchImpl,
    signal,
  );
  const oauth =
    /\bresource_metadata\s*=/i.test(challenge) ||
    metadata?.namesAuthorizationServer === true;
  return withoutUndefined({
    result: oauth ? ("oauth" as const) : ("credential" as const),
    authMetadata: metadata?.authMetadata,
  });
}

/**
 * The first location that serves protected-resource metadata: whether it
 * names an authorization server, and its `resource_name` and https
 * `resource_documentation`. Undefined when none does.
 */
async function readProtectedResourceMetadata(
  locations: string[],
  fetchImpl: typeof globalThis.fetch,
  signal: AbortSignal,
): Promise<ProtectedResourceMetadata | undefined> {
  for (const metadataUrl of locations) {
    try {
      const response = await fetchImpl(metadataUrl, {
        method: "GET",
        redirect: "manual",
        headers: { accept: "application/json" },
        signal,
      });
      if (response.status !== 200) {
        await response.body?.cancel();
        continue;
      }
      const metadata = JSON.parse(
        await readCappedText(response, METADATA_MAX_BYTES),
      ) as unknown;
      if (!isRecord(metadata)) continue;
      const servers = metadata.authorization_servers;
      const authMetadata = withoutUndefined({
        resourceName: boundedString(
          metadata.resource_name,
          MCP_PROBE_LIMITS.stringChars,
        ),
        resourceDocumentation: httpsUrl(metadata.resource_documentation),
      });
      return {
        namesAuthorizationServer: Array.isArray(servers) && servers.length > 0,
        authMetadata:
          Object.keys(authMetadata).length > 0 ? authMetadata : undefined,
      };
    } catch {
      // Unreachable, timed out or not JSON: no metadata at this location.
      if (signal.aborted) return undefined;
    }
  }
  return undefined;
}

/**
 * The origin's MCP server card (SEP-1649), when it serves one: a non-empty
 * JSON object served as JSON, at most 64 KiB. Nothing is read from it yet; it
 * is kept as published.
 */
async function readServerCard(
  endpointUrl: string,
  fetchImpl: typeof globalThis.fetch,
  signal: AbortSignal,
): Promise<Record<string, unknown> | undefined> {
  if (signal.aborted) return undefined;
  try {
    const response = await fetchImpl(
      `${new URL(endpointUrl).origin}/.well-known/mcp/server-card.json`,
      {
        method: "GET",
        redirect: "manual",
        headers: { accept: "application/json" },
        signal,
      },
    );
    if (
      response.status !== 200 ||
      !/json/i.test(response.headers.get("content-type") ?? "")
    ) {
      await response.body?.cancel();
      return undefined;
    }
    const card = JSON.parse(
      await readCappedText(response, METADATA_MAX_BYTES),
    ) as unknown;
    return isRecord(card) && Object.keys(card).length > 0 ? card : undefined;
  } catch {
    return undefined;
  }
}
