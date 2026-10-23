import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";

/**
 * A tool as an MCP endpoint lists it to an anonymous client, cut to the
 * public fields and bounded by `MCP_TOOL_LISTING_LIMITS`. The server's own
 * annotations are hints it asserts about itself; callers never derive an
 * approval risk from them.
 */
export type McpListedTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
};

export const MCP_TOOL_LISTING_LIMITS = {
  timeoutMs: 10_000,
  // Every response of one listing together; a tools page is a few KiB per tool.
  responseBytes: 4 * 1024 * 1024,
  pages: 10,
  tools: 200,
  nameChars: 128,
  titleChars: 200,
  descriptionChars: 2_000,
  // An input schema past this is kept as its parameter names and types only.
  schemaBytes: 16 * 1024,
  schemaProperties: 64,
};

// The hints of the MCP spec's ToolAnnotations; anything else is dropped.
const ANNOTATION_HINTS = [
  "readOnlyHint",
  "destructiveHint",
  "idempotentHint",
  "openWorldHint",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedText(value: unknown, limit: number) {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text ? text.slice(0, limit) : undefined;
}

/**
 * The input schema as listed when it is small enough; otherwise an object
 * schema with only each parameter's type, so a page can still name them.
 */
function boundedInputSchema(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  if (
    Buffer.byteLength(JSON.stringify(value)) <=
    MCP_TOOL_LISTING_LIMITS.schemaBytes
  ) {
    return value;
  }
  const properties = isRecord(value.properties) ? value.properties : {};
  const names = Object.keys(properties).slice(
    0,
    MCP_TOOL_LISTING_LIMITS.schemaProperties,
  );
  const required = Array.isArray(value.required)
    ? value.required.filter(
        (name): name is string =>
          typeof name === "string" && names.includes(name),
      )
    : [];
  return {
    type: "object",
    properties: Object.fromEntries(
      names.map((name) => {
        const type = (properties[name] as { type?: unknown } | null)?.type;
        return [name, typeof type === "string" ? { type } : {}];
      }),
    ),
    ...(required.length > 0 ? { required } : {}),
  };
}

function boundedAnnotations(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const kept: Record<string, unknown> = {};
  const title = boundedText(value.title, MCP_TOOL_LISTING_LIMITS.titleChars);
  if (title) kept.title = title;
  for (const hint of ANNOTATION_HINTS) {
    if (typeof value[hint] === "boolean") kept[hint] = value[hint];
  }
  return kept;
}

/**
 * The listed tools, bounded: unnamed and repeated names are dropped, and at
 * most `MCP_TOOL_LISTING_LIMITS.tools` are kept, in the server's order.
 */
export function boundedMcpListedTools(raw: readonly unknown[]) {
  const tools: McpListedTool[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (tools.length >= MCP_TOOL_LISTING_LIMITS.tools) break;
    if (!isRecord(entry)) continue;
    const name = boundedText(entry.name, Number.POSITIVE_INFINITY);
    if (!name || name.length > MCP_TOOL_LISTING_LIMITS.nameChars) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    const title = boundedText(entry.title, MCP_TOOL_LISTING_LIMITS.titleChars);
    const description = boundedText(
      entry.description,
      MCP_TOOL_LISTING_LIMITS.descriptionChars,
    );
    tools.push({
      name,
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      inputSchema: boundedInputSchema(entry.inputSchema),
      annotations: boundedAnnotations(entry.annotations),
    });
  }
  return tools;
}

// Each tool is bounded on its own afterwards, so one malformed tool (which the
// SDK's strict `listTools` would reject the whole page for) is only dropped.
const toolsPageSchema = z.looseObject({
  tools: z.array(z.unknown()).default([]),
  nextCursor: z.string().optional(),
});

/**
 * `fetchImpl` with every request tied to `signal` and every response body
 * counted against one shared byte budget; past it the body errors and the
 * listing fails.
 */
function budgetedFetch(
  fetchImpl: typeof globalThis.fetch,
  signal: AbortSignal,
): typeof globalThis.fetch {
  let remaining = MCP_TOOL_LISTING_LIMITS.responseBytes;
  return async (input, init) => {
    const response = await fetchImpl(input, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal,
    });
    if (!response.body) return response;
    const counted = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          remaining -= chunk.byteLength;
          if (remaining < 0) {
            controller.error(new Error("MCP tool listing is too large"));
            return;
          }
          controller.enqueue(chunk);
        },
      }),
    );
    return new Response(counted, {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    });
  };
}

/**
 * The tools an MCP endpoint lists to a client that sends no credentials:
 * `initialize`, then `tools/list` page by page. Requests go through
 * `fetchImpl`, which the caller scopes to its endpoint policy. One time and
 * byte budget covers the whole listing; a failure of any request is thrown.
 */
export async function listMcpEndpointTools(
  endpointUrl: string,
  transport: "streamable_http" | "http_sse_compat" | "sse",
  fetchImpl: typeof globalThis.fetch,
): Promise<McpListedTool[]> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("MCP tool listing timed out")),
    MCP_TOOL_LISTING_LIMITS.timeoutMs,
  );
  const options = { fetch: budgetedFetch(fetchImpl, controller.signal) };
  const client = new Client({ name: "sourceweft-tool-listing", version: "1" });
  const requestOptions = {
    signal: controller.signal,
    timeout: MCP_TOOL_LISTING_LIMITS.timeoutMs,
  };
  try {
    await client.connect(
      transport === "sse"
        ? new SSEClientTransport(new URL(endpointUrl), options)
        : new StreamableHTTPClientTransport(new URL(endpointUrl), options),
      requestOptions,
    );
    const raw: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MCP_TOOL_LISTING_LIMITS.pages; page += 1) {
      const result = await client.request(
        { method: "tools/list", params: cursor ? { cursor } : {} },
        toolsPageSchema,
        requestOptions,
      );
      raw.push(...result.tools);
      cursor = result.nextCursor;
      if (!cursor || raw.length >= MCP_TOOL_LISTING_LIMITS.tools) break;
    }
    return boundedMcpListedTools(raw);
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => {});
  }
}
