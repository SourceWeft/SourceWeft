import { ComposioBrokerError, classifyComposioError } from "./errors";
import type { ComposioBrokerErrorCode } from "./errors";

// https://backend.composio.dev/api/v3.1 — current REST API version, per the
// Composio docs saved for this task (custom-tools.md, read 2026-11-15).
const BASE_URL = "https://backend.composio.dev/api/v3.1";
const REQUEST_TIMEOUT_MS = 15_000;

export type ComposioLogger = {
  info?(message: string, meta?: Record<string, unknown>): void;
  error?(message: string, meta?: Record<string, unknown>): void;
};

export type ComposioBrokerConfig = {
  apiKey: string;
  fetcher?: typeof fetch;
  logger?: ComposioLogger;
};

export type CreateLinkInput = {
  toolkit: string;
  ownerRef: string;
  callbackUrl: string;
};

export type CreateLinkResult = {
  authorizationUrl: string;
  connectedAccountId: string;
};

export type ConnectedAccount = {
  id: string;
  status: string;
  toolkit: string;
};

export type ProxyInput = {
  connectedAccountId: string;
  ownerRef: string;
  url: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: unknown;
};

export type ProxyResult = {
  status: number;
  data: unknown;
  headers: Record<string, string>;
};

export type ComposioBroker = {
  createLink(input: CreateLinkInput): Promise<CreateLinkResult>;
  getConnectedAccount(id: string): Promise<ConnectedAccount>;
  deleteConnectedAccount(id: string): Promise<void>; // resolves when Composio answers 404
  proxy(input: ProxyInput): Promise<ProxyResult>;
};

type SendArgs = {
  operation: string;
  toolkit?: string;
  method: "GET" | "POST" | "DELETE";
  path: string;
  body?: unknown;
};

type SendResult = {
  status: number;
  text: string;
  json: unknown;
};

export function createComposioBroker(config: ComposioBrokerConfig): ComposioBroker {
  const fetcher = config.fetcher ?? fetch;
  const apiKey = config.apiKey;
  const logger = config.logger;

  function logInfo(
    operation: string,
    toolkit: string | undefined,
    status: number,
    durationMs: number,
  ) {
    logger?.info?.("composio_call", {
      operation,
      ...(toolkit !== undefined ? { toolkit } : {}),
      status,
      durationMs,
    });
  }

  function logErrorIfNeeded(
    operation: string,
    toolkit: string | undefined,
    code: ComposioBrokerErrorCode,
    status: number,
  ) {
    if (code === "COMPOSIO_AUTH" || code === "COMPOSIO_QUOTA") {
      logger?.error?.("composio_call", {
        operation,
        ...(toolkit !== undefined ? { toolkit } : {}),
        status,
        code,
      });
    }
  }

  // Exactly one attempt per call: no retry here (a retrying caller, such as
  // the Gmail connector adapter, owns that policy).
  async function send(args: SendArgs): Promise<SendResult> {
    const { operation, toolkit, method, path, body } = args;
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const start = Date.now();
    let response: Response;
    try {
      response = await fetcher(`${BASE_URL}${path}`, {
        method,
        headers: {
          "x-api-key": apiKey,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      const durationMs = Date.now() - start;
      logInfo(operation, toolkit, 0, durationMs);
      throw new ComposioBrokerError(
        "COMPOSIO_UNAVAILABLE",
        0,
        "Composio request failed: network error or timeout",
      );
    } finally {
      clearTimeout(timeoutHandle);
    }

    const durationMs = Date.now() - start;
    const status = response.status;
    let text = "";
    try {
      text = await response.text();
    } catch {
      text = "";
    }
    let json: unknown;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    logInfo(operation, toolkit, status, durationMs);
    return { status, text, json };
  }

  function throwForStatus(
    operation: string,
    toolkit: string | undefined,
    status: number,
    text: string,
  ): never {
    const code = classifyComposioError(status, text);
    logErrorIfNeeded(operation, toolkit, code, status);
    throw new ComposioBrokerError(code, status, `Composio request failed with status ${status}`);
  }

  function isSuccess(status: number): boolean {
    return status >= 200 && status < 300;
  }

  // A 2xx Composio answer that is missing a field this method must return is
  // a malformed/unexpected response, not a value we can silently coerce to
  // "undefined" or an empty string: surface it as a clear client-side
  // failure instead of building a request with "undefined" in it or
  // returning a result typed as a string that is actually missing. Only the
  // field name is included in the message, never the response body.
  function requireField<T>(value: T | undefined | null, fieldName: string, status: number): T {
    if (value === undefined || value === null) {
      throw new ComposioBrokerError(
        "COMPOSIO_REQUEST_FAILED",
        status,
        `Composio response is missing required field: ${fieldName}`,
      );
    }
    return value;
  }

  return {
    async createLink(input) {
      const sessionResult = await send({
        operation: "create_link_session",
        toolkit: input.toolkit,
        method: "POST",
        path: "/tool_router/session",
        body: {
          user_id: input.ownerRef,
          toolkits: { enable: [input.toolkit] },
        },
      });
      if (!isSuccess(sessionResult.status)) {
        throwForStatus("create_link_session", input.toolkit, sessionResult.status, sessionResult.text);
      }
      const sessionBody = sessionResult.json as { session_id?: string } | undefined;
      const sessionId = requireField(sessionBody?.session_id, "session_id", sessionResult.status);

      const linkResult = await send({
        operation: "create_link",
        toolkit: input.toolkit,
        method: "POST",
        path: `/tool_router/session/${encodeURIComponent(sessionId)}/link`,
        body: {
          toolkit: input.toolkit,
          callback_url: input.callbackUrl,
        },
      });
      if (!isSuccess(linkResult.status)) {
        throwForStatus("create_link", input.toolkit, linkResult.status, linkResult.text);
      }
      const linkBody = linkResult.json as
        | { redirect_url?: string; connected_account_id?: string }
        | undefined;
      const connectedAccountId = requireField(
        linkBody?.connected_account_id,
        "connected_account_id",
        linkResult.status,
      );
      const authorizationUrl = requireField(linkBody?.redirect_url, "redirect_url", linkResult.status);
      return { authorizationUrl, connectedAccountId };
    },

    async getConnectedAccount(id) {
      const result = await send({
        operation: "get_connected_account",
        method: "GET",
        path: `/connected_accounts/${encodeURIComponent(id)}`,
      });
      if (!isSuccess(result.status)) {
        throwForStatus("get_connected_account", undefined, result.status, result.text);
      }
      const body = result.json as
        | { id?: string; status?: string; toolkit?: { slug?: string } }
        | undefined;
      const status = requireField(body?.status, "status", result.status);
      const toolkit = requireField(body?.toolkit?.slug, "toolkit.slug", result.status);
      return {
        id: body?.id ?? id,
        status,
        toolkit,
      };
    },

    async deleteConnectedAccount(id) {
      const result = await send({
        operation: "delete_connected_account",
        method: "DELETE",
        path: `/connected_accounts/${encodeURIComponent(id)}`,
      });
      if (result.status === 404) {
        return;
      }
      if (!isSuccess(result.status)) {
        throwForStatus("delete_connected_account", undefined, result.status, result.text);
      }
    },

    async proxy(input) {
      const parameters: Array<{ name: string; value: string; type: "query" | "header" }> = [];
      for (const [name, value] of Object.entries(input.query ?? {})) {
        parameters.push({ name, value, type: "query" });
      }
      for (const [name, value] of Object.entries(input.headers ?? {})) {
        // Composio injects the connected account's own credential; a
        // caller-supplied Authorization value would override it and is
        // never forwarded (see proxy.md's warning against setting it
        // manually).
        if (name.toLowerCase() === "authorization") continue;
        parameters.push({ name, value, type: "header" });
      }
      const result = await send({
        operation: "proxy",
        method: "POST",
        path: "/tools/execute/proxy",
        body: {
          user_id: input.ownerRef,
          connected_account_id: input.connectedAccountId,
          endpoint: input.url,
          method: input.method,
          body: input.body,
          parameters,
        },
      });
      if (!isSuccess(result.status)) {
        throwForStatus("proxy", undefined, result.status, result.text);
      }
      const body = result.json as
        | { status?: number; data?: unknown; headers?: Record<string, string> }
        | undefined;
      return {
        status: body?.status ?? result.status,
        data: body?.data,
        headers: body?.headers ?? {},
      };
    },
  };
}
