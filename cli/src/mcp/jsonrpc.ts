import { printable } from "./oauth/redact";
import { McpInspectError } from "../errors";

/**
 * The slice of JSON-RPC 2.0 the inspect client needs: it sends requests and
 * notifications, and reads responses. A server's own requests (roots/list,
 * sampling, elicitation) are answered "method not found"; its notifications
 * are ignored.
 */

export type JsonRpcId = number | string;

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
};

export type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
};

export type JsonRpcErrorBody = { code: number; message: string; data?: unknown };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A frame with a `method` is a request or notification from the server. */
export function isServerMethodCall(
  message: Record<string, unknown>,
): message is Record<string, unknown> & { method: string } {
  return typeof message.method === "string";
}

/** Whether the frame is the response to the request with this id. */
export function isResponseTo(
  message: Record<string, unknown>,
  id: JsonRpcId,
): boolean {
  if (isServerMethodCall(message)) return false;
  const got = message.id;
  if (got === undefined || got === null) return false;
  return typeof got === "number" || typeof got === "string"
    ? String(got) === String(id)
    : false;
}

export function methodNotFound(id: unknown): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: "Method not found" },
  };
}

/** The result of a response, or the error it carries as a thrown failure. */
export function resultOf(
  message: Record<string, unknown>,
  method: string,
): unknown {
  if (message.error !== undefined) {
    const error = message.error;
    const text =
      isRecord(error) && typeof error.message === "string"
        ? error.message
        : JSON.stringify(error);
    const code =
      isRecord(error) && typeof error.code === "number" ? ` (${error.code})` : "";
    throw new McpInspectError(
      `The server answered ${method} with an error${code}: ${printable(String(text), 300)}`,
    );
  }
  return message.result;
}

/**
 * What both transports offer the handshake: a request that resolves with the
 * server's result, a one-way notification, and a way to let the server go.
 */
export type McpTransport = {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  notify(method: string, params?: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
};
