import { McpInspectError, McpUnauthorizedError } from "../errors";
import { printable } from "./oauth/redact";
import {
  isRecord,
  isResponseTo,
  resultOf,
  type JsonRpcId,
  type McpTransport,
} from "./jsonrpc";

/**
 * MCP Streamable HTTP: every message is a POST to the one endpoint; the
 * answer comes back as one JSON message or as a `text/event-stream` holding
 * it. The user's headers go on every request verbatim and are never kept
 * anywhere else; the session id the server hands out on `initialize` is
 * echoed on what follows.
 */

/** One request, from the POST to the end of its body. */
export const HTTP_TIMEOUT_MS = 10_000;
/** Bytes one response body may hold. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const SESSION_HEADER = "mcp-session-id";

/** Reads the body as text, failing once it passes the cap. */
async function readCappedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new McpInspectError("The server's response is larger than 8 MiB.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The `data` of each event in an SSE body, in order. */
export function parseSseData(body: string): string[] {
  const events: string[] = [];
  let data: string[] = [];
  const flush = () => {
    if (data.length > 0) events.push(data.join("\n"));
    data = [];
  };
  for (const rawLine of body.split(/\r\n|\r|\n/u)) {
    if (rawLine === "") {
      flush();
      continue;
    }
    if (rawLine.startsWith(":")) continue;
    const colon = rawLine.indexOf(":");
    const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
    if (field !== "data") continue;
    let value = colon === -1 ? "" : rawLine.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    data.push(value);
  }
  flush();
  return events;
}

/** Every JSON-RPC message a response body holds, whichever framing it uses. */
function messagesIn(contentType: string, body: string): unknown[] {
  const type = contentType.toLowerCase();
  if (type.includes("text/event-stream")) {
    const messages: unknown[] = [];
    for (const data of parseSseData(body)) {
      try {
        messages.push(JSON.parse(data));
      } catch {
        // Not a JSON-RPC frame (a keep-alive, a comment); skip it.
      }
    }
    return messages;
  }
  if (type.includes("application/json")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new McpInspectError("The server answered with invalid JSON.");
    }
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  throw new McpInspectError(
    `The server answered with ${contentType || "no content type"} instead of JSON or an event stream. Is this an MCP Streamable HTTP endpoint?`,
  );
}

export function createHttpTransport(
  url: string,
  userHeaders: Readonly<Record<string, string>>,
  options: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    /** What a 401/403 means for this caller; the default points at `--header`. */
    unauthorizedMessage?: (status: number, method: string) => string;
  } = {},
): McpTransport {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? HTTP_TIMEOUT_MS;
  let sessionId: string | undefined;
  let nextId = 1;

  /** One POST under one time budget that also covers reading its body. */
  const post = async (
    message: Record<string, unknown>,
    method: string,
    signal: AbortSignal,
  ): Promise<Response> => {
    const headers: Record<string, string> = {
      ...userHeaders,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (sessionId !== undefined) headers[SESSION_HEADER] = sessionId;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(message),
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw timedOut(method);
      const cause =
        error instanceof Error && error.cause instanceof Error
          ? error.cause.message
          : error instanceof Error
            ? error.message
            : String(error);
      throw new McpInspectError(`Could not reach the server (${cause}).`);
    }
    const session = response.headers.get(SESSION_HEADER);
    if (session) sessionId = session;
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      const insufficientScope = /insufficient_scope/iu.test(
        response.headers.get("www-authenticate") ?? "",
      );
      throw new McpUnauthorizedError(
        options.unauthorizedMessage?.(response.status, method) ??
          `The server refused the credentials (HTTP ${response.status}) on ${method}. Pass the header it expects with --header "Authorization: Bearer <token>" (repeatable); it is sent to the server and never written to the file.`,
        response.status === 401 && !insufficientScope,
      );
    }
    return response;
  };

  const timedOut = (method: string) =>
    new McpInspectError(
      `The server did not answer ${method} within ${Math.round(timeoutMs / 1000)} s.`,
    );

  const readResponse = async (
    response: Response,
    id: JsonRpcId,
    method: string,
    signal: AbortSignal,
  ): Promise<unknown> => {
    const contentType = response.headers.get("content-type") ?? "";
    let body: string;
    try {
      body = await readCappedText(response);
    } catch (error) {
      if (signal.aborted) throw timedOut(method);
      throw error instanceof McpInspectError
        ? error
        : new McpInspectError(
            `The server's answer to ${method} could not be read (${error instanceof Error ? error.message : String(error)}).`,
          );
    }
    if (!response.ok) {
      throw new McpInspectError(
        `The server answered ${method} with HTTP ${response.status}${
          body ? `: ${printable(body, 300)}` : ""
        }`,
      );
    }
    for (const message of messagesIn(contentType, body)) {
      if (isRecord(message) && isResponseTo(message, id)) {
        return resultOf(message, method);
      }
      // A server→client request or notification in the stream: this client
      // offers no roots, sampling or elicitation, so there is nothing to say.
    }
    throw new McpInspectError(
      `The server's answer to ${method} held no response to it.`,
    );
  };

  return {
    async request(method, params) {
      const id = nextId++;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await post(
          { jsonrpc: "2.0", id, method, params },
          method,
          controller.signal,
        );
        return await readResponse(response, id, method, controller.signal);
      } finally {
        clearTimeout(timer);
      }
    },
    async notify(method, params) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await post(
          { jsonrpc: "2.0", method, ...(params ? { params } : {}) },
          method,
          controller.signal,
        );
        // 202 Accepted is what the spec asks for; any 2xx body is of no use.
        await response.body?.cancel();
      } finally {
        clearTimeout(timer);
      }
    },
    async close() {
      // Streamable HTTP lets a client end its session with DELETE; servers
      // may refuse, and the session expires on its own either way.
      if (sessionId === undefined) return;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2_000);
      try {
        const response = await fetchImpl(url, {
          method: "DELETE",
          headers: { ...userHeaders, [SESSION_HEADER]: sessionId },
          signal: controller.signal,
        });
        await response.body?.cancel();
      } catch {
        // Best effort only.
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
