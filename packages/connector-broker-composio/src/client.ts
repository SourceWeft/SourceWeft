import { ComposioBrokerError, classifyComposioError } from "./errors";
import type { ComposioBrokerErrorCode } from "./errors";

// https://backend.composio.dev/api/v3.1 — current REST API version, per the
// Composio docs saved for this task (custom-tools.md, read 2026-11-15).
const BASE_URL = "https://backend.composio.dev/api/v3.1";
const REQUEST_TIMEOUT_MS = 15_000;
const AUTH_CONFIG_PAGE_SIZE = 100;
// A project holds a handful of auth configs per toolkit; this only bounds a
// runaway cursor.
const AUTH_CONFIG_MAX_PAGES = 20;

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
  /**
   * The provider scopes the consent screen may ask for, and nothing more.
   * Composio's managed apps ask for a wide default set (for Gmail: profile,
   * contacts, addresses, birthday and phone numbers on top of the mailbox),
   * so every caller states its scopes and the link is pinned to an auth
   * config that carries exactly these.
   */
  scopes: string[];
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

  // Every ComposioBrokerError this client throws is logged once at error
  // level with its cause (operation, status, code, and toolkit when known) —
  // an outage, a timeout, an unexpected 4xx and a malformed 2xx alike, not
  // only bad-key and quota. The fields never include a request/response body,
  // an id, or the API key.
  function logError(
    operation: string,
    toolkit: string | undefined,
    code: ComposioBrokerErrorCode,
    status: number,
  ) {
    logger?.error?.("composio_call", {
      operation,
      ...(toolkit !== undefined ? { toolkit } : {}),
      status,
      code,
    });
  }

  function fail(
    operation: string,
    toolkit: string | undefined,
    code: ComposioBrokerErrorCode,
    status: number,
    message: string,
  ): never {
    logError(operation, toolkit, code, status);
    throw new ComposioBrokerError(code, status, message);
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
      return fail(
        operation,
        toolkit,
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
    return fail(
      operation,
      toolkit,
      code,
      status,
      `Composio request failed with status ${status}`,
    );
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
  function requireField<T>(
    value: T | undefined | null,
    fieldName: string,
    status: number,
    operation: string,
    toolkit: string | undefined,
  ): T {
    if (value === undefined || value === null) {
      return fail(
        operation,
        toolkit,
        "COMPOSIO_REQUEST_FAILED",
        status,
        `Composio response is missing required field: ${fieldName}`,
      );
    }
    return value;
  }

  type AuthConfigRecord = {
    id?: string;
    is_composio_managed?: boolean;
    status?: string;
    created_at?: string;
    credentials?: { scopes?: unknown };
  };

  // True only for an enabled auth config on Composio's managed app whose
  // scope list is exactly the requested one: a config with an extra scope
  // would widen the consent, one with a missing scope would break a call.
  function authConfigMatches(record: AuthConfigRecord, scopes: string[]): boolean {
    if (record.is_composio_managed !== true || record.status !== "ENABLED") {
      return false;
    }
    const actual = record.credentials?.scopes;
    if (!Array.isArray(actual) || actual.length !== scopes.length) return false;
    const wanted = new Set(scopes);
    return actual.every((scope) => typeof scope === "string" && wanted.has(scope));
  }

  async function findAuthConfig(toolkit: string, scopes: string[]): Promise<string | null> {
    const matches: Array<{ id: string; createdAt: string }> = [];
    let cursor: string | null = null;
    for (let page = 0; page < AUTH_CONFIG_MAX_PAGES; page += 1) {
      const query = new URLSearchParams({
        toolkit_slug: toolkit,
        is_composio_managed: "true",
        limit: String(AUTH_CONFIG_PAGE_SIZE),
      });
      if (cursor) query.set("cursor", cursor);
      const result = await send({
        operation: "list_auth_configs",
        toolkit,
        method: "GET",
        path: `/auth_configs?${query.toString()}`,
      });
      if (!isSuccess(result.status)) {
        throwForStatus("list_auth_configs", toolkit, result.status, result.text);
      }
      const body = result.json as
        | { items?: AuthConfigRecord[]; next_cursor?: string | null }
        | undefined;
      const items = requireField(
        Array.isArray(body?.items) ? body.items : undefined,
        "items",
        result.status,
        "list_auth_configs",
        toolkit,
      );
      for (const item of items) {
        if (typeof item.id === "string" && authConfigMatches(item, scopes)) {
          matches.push({ id: item.id, createdAt: item.created_at ?? "" });
        }
      }
      cursor = typeof body?.next_cursor === "string" && body.next_cursor ? body.next_cursor : null;
      if (!cursor) break;
    }
    if (matches.length === 0) return null;
    // Several matching configs are equivalent; take the oldest so every
    // process settles on the same one.
    matches.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    return matches[0]?.id ?? null;
  }

  async function createAuthConfig(toolkit: string, scopes: string[]): Promise<string> {
    const created = await send({
      operation: "create_auth_config",
      toolkit,
      method: "POST",
      path: "/auth_configs",
      body: {
        toolkit: { slug: toolkit },
        auth_config: {
          type: "use_composio_managed_auth",
          name: `sourceweft-${toolkit}`,
          // Composio takes the scope list as one comma-separated string.
          credentials: { scopes: scopes.join(",") },
        },
      },
    });
    if (!isSuccess(created.status)) {
      throwForStatus("create_auth_config", toolkit, created.status, created.text);
    }
    const createdBody = created.json as { auth_config?: { id?: string } } | undefined;
    const id = requireField(
      createdBody?.auth_config?.id,
      "auth_config.id",
      created.status,
      "create_auth_config",
      toolkit,
    );
    // The create answer does not echo the scopes. Read the config back and
    // refuse to use it unless it carries exactly the requested ones, so a
    // create that Composio accepted but did not apply can never widen a
    // consent screen unnoticed.
    const check = await send({
      operation: "get_auth_config",
      toolkit,
      method: "GET",
      path: `/auth_configs/${encodeURIComponent(id)}`,
    });
    if (!isSuccess(check.status)) {
      throwForStatus("get_auth_config", toolkit, check.status, check.text);
    }
    if (!authConfigMatches((check.json ?? {}) as AuthConfigRecord, scopes)) {
      return fail(
        "get_auth_config",
        toolkit,
        "COMPOSIO_REQUEST_FAILED",
        check.status,
        "Composio auth config does not carry the requested scopes",
      );
    }
    return id;
  }

  // One lookup per toolkit and scope set for the life of the process. A
  // failed lookup is not remembered, and a session that Composio refuses
  // forgets the id (the config may have been deleted or disabled since).
  const authConfigIds = new Map<string, Promise<string>>();

  function authConfigKey(toolkit: string, scopes: string[]): string {
    return `${toolkit}\n${[...scopes].sort().join("\n")}`;
  }

  function resolveAuthConfig(toolkit: string, scopes: string[]): Promise<string> {
    const key = authConfigKey(toolkit, scopes);
    const cached = authConfigIds.get(key);
    if (cached) return cached;
    const pending = (async () => {
      const existing = await findAuthConfig(toolkit, scopes);
      return existing ?? (await createAuthConfig(toolkit, scopes));
    })();
    authConfigIds.set(key, pending);
    pending.catch(() => {
      if (authConfigIds.get(key) === pending) authConfigIds.delete(key);
    });
    return pending;
  }

  return {
    async createLink(input) {
      if (input.scopes.length === 0 || input.scopes.some((scope) => !scope || scope.includes(","))) {
        return fail(
          "create_link_session",
          input.toolkit,
          "COMPOSIO_REQUEST_FAILED",
          0,
          "A Composio link needs a non-empty list of provider scopes",
        );
      }
      const authConfigId = await resolveAuthConfig(input.toolkit, input.scopes);
      const sessionResult = await send({
        operation: "create_link_session",
        toolkit: input.toolkit,
        method: "POST",
        path: "/tool_router/session",
        body: {
          user_id: input.ownerRef,
          toolkits: { enable: [input.toolkit] },
          auth_configs: { [input.toolkit]: authConfigId },
          // The session exists only to mint a connect link. Its sandbox
          // (Workbench, remote shell, large-answer offloading) is never
          // used, so it stays off.
          workbench: { enable: false },
        },
      });
      if (!isSuccess(sessionResult.status)) {
        authConfigIds.delete(authConfigKey(input.toolkit, input.scopes));
        throwForStatus("create_link_session", input.toolkit, sessionResult.status, sessionResult.text);
      }
      const sessionBody = sessionResult.json as
        | {
            session_id?: string;
            config?: { auth_configs?: Record<string, unknown> };
          }
        | undefined;
      const sessionId = requireField(
        sessionBody?.session_id,
        "session_id",
        sessionResult.status,
        "create_link_session",
        input.toolkit,
      );
      // The session must confirm it is pinned to our auth config. Without
      // that the link would fall back to the managed app's default scopes.
      if (sessionBody?.config?.auth_configs?.[input.toolkit] !== authConfigId) {
        authConfigIds.delete(authConfigKey(input.toolkit, input.scopes));
        return fail(
          "create_link_session",
          input.toolkit,
          "COMPOSIO_REQUEST_FAILED",
          sessionResult.status,
          "Composio session is not pinned to the requested auth config",
        );
      }

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
        "create_link",
        input.toolkit,
      );
      const authorizationUrl = requireField(
        linkBody?.redirect_url,
        "redirect_url",
        linkResult.status,
        "create_link",
        input.toolkit,
      );
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
      const status = requireField(
        body?.status,
        "status",
        result.status,
        "get_connected_account",
        undefined,
      );
      const toolkit = requireField(
        body?.toolkit?.slug,
        "toolkit.slug",
        result.status,
        "get_connected_account",
        undefined,
      );
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
      // The proxy answer must carry the provider's own numeric status. We do
      // not fall back to the Composio HTTP status (always a success here): a
      // 2xx envelope without a numeric `status` is a malformed answer, not a
      // successful Gmail call, and silently coercing it would hide the real
      // failure (I7).
      const envelopeStatus = body?.status;
      if (typeof envelopeStatus !== "number") {
        return fail(
          "proxy",
          undefined,
          "COMPOSIO_REQUEST_FAILED",
          result.status,
          "Composio response is missing required field: status",
        );
      }
      return {
        status: envelopeStatus,
        data: body?.data,
        headers: body?.headers ?? {},
      };
    },
  };
}
