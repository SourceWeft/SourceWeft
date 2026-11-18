import assert from "node:assert/strict";
import test from "node:test";
import { ComposioBrokerError, createComposioBroker } from "../src/index";
import type { ComposioBrokerErrorCode } from "../src/index";

type FakeCall = {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: unknown;
};

type FakeResponder = (call: FakeCall) => {
  status: number;
  json?: unknown;
} | Promise<never>;

function fakeFetcher(responder: FakeResponder, calls: FakeCall[]): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    const rawHeaders = init?.headers as Record<string, string> | undefined;
    if (rawHeaders) {
      for (const [key, value] of Object.entries(rawHeaders)) {
        headers[key.toLowerCase()] = value;
      }
    }
    const call: FakeCall = {
      url: String(input),
      method: init?.method,
      headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const result = responder(call);
    if (result instanceof Promise) {
      return await result;
    }
    const { status, json } = result;
    return {
      status,
      text: async () => (json === undefined ? "" : JSON.stringify(json)),
    } as unknown as Response;
  }) as typeof fetch;
}

function collectingLogger() {
  const info: Array<[string, Record<string, unknown> | undefined]> = [];
  const error: Array<[string, Record<string, unknown> | undefined]> = [];
  return {
    logger: {
      info: (message: string, meta?: Record<string, unknown>) => {
        info.push([message, meta]);
      },
      error: (message: string, meta?: Record<string, unknown>) => {
        error.push([message, meta]);
      },
    },
    info,
    error,
  };
}

const MAIL_SCOPE = "https://mail.google.com/";

function authConfigItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "ac_existing",
    is_composio_managed: true,
    status: "ENABLED",
    created_at: "2026-11-16T00:00:00.000Z",
    credentials: { scopes: [MAIL_SCOPE] },
    ...overrides,
  };
}

function isAuthConfigList(call: FakeCall): boolean {
  return call.method === "GET" && call.url.includes("/auth_configs?");
}

const AUTH_CONFIG_LIST = { status: 200, json: { items: [authConfigItem()], next_cursor: null } };

function pinnedSession(authConfigId = "ac_existing") {
  return {
    status: 201,
    json: { session_id: "sess_1", config: { auth_configs: { gmail: authConfigId } } },
  };
}

const LINK_ANSWER = {
  status: 201,
  json: {
    redirect_url: "https://connect.composio.dev/link/ln_abc123",
    connected_account_id: "ca_abc123",
  },
};

const LINK_INPUT = {
  toolkit: "gmail",
  ownerRef: "org_1:user_1",
  callbackUrl: "https://app.example.com/callback",
  scopes: [MAIL_SCOPE],
};

test("createLink pins the session to the matching auth config, sends x-api-key and returns the link", async () => {
  const calls: FakeCall[] = [];
  const fetcher = fakeFetcher((call) => {
    if (isAuthConfigList(call)) return AUTH_CONFIG_LIST;
    if (call.url.endsWith("/tool_router/session")) return pinnedSession();
    if (call.url.endsWith("/tool_router/session/sess_1/link")) return LINK_ANSWER;
    throw new Error(`unexpected url ${call.url}`);
  }, calls);

  const broker = createComposioBroker({ apiKey: "sk_test_key", fetcher });
  const result = await broker.createLink(LINK_INPUT);

  assert.equal(result.authorizationUrl, "https://connect.composio.dev/link/ln_abc123");
  assert.equal(result.connectedAccountId, "ca_abc123");
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.headers["x-api-key"], "sk_test_key");
  }
  const listUrl = new URL(calls[0]!.url);
  assert.equal(listUrl.searchParams.get("toolkit_slug"), "gmail");
  assert.equal(listUrl.searchParams.get("is_composio_managed"), "true");
  assert.deepEqual(calls[1]?.body, {
    user_id: "org_1:user_1",
    toolkits: { enable: ["gmail"] },
    auth_configs: { gmail: "ac_existing" },
    workbench: { enable: false },
  });
  assert.deepEqual(calls[2]?.body, {
    toolkit: "gmail",
    callback_url: "https://app.example.com/callback",
  });
});

test("createLink creates a managed auth config with exactly the requested scopes when none matches", async () => {
  const calls: FakeCall[] = [];
  const fetcher = fakeFetcher((call) => {
    if (isAuthConfigList(call)) {
      return {
        status: 200,
        json: {
          items: [
            // The managed app's default config: the mailbox plus profile data.
            authConfigItem({
              id: "ac_wide",
              credentials: { scopes: [MAIL_SCOPE, "https://www.googleapis.com/auth/contacts.readonly"] },
            }),
            authConfigItem({ id: "ac_disabled", status: "DISABLED" }),
            authConfigItem({ id: "ac_own_app", is_composio_managed: false }),
          ],
          next_cursor: null,
        },
      };
    }
    if (call.method === "POST" && call.url.endsWith("/auth_configs")) {
      return { status: 201, json: { toolkit: { slug: "gmail" }, auth_config: { id: "ac_new" } } };
    }
    if (call.method === "GET" && call.url.endsWith("/auth_configs/ac_new")) {
      return { status: 200, json: authConfigItem({ id: "ac_new" }) };
    }
    if (call.url.endsWith("/tool_router/session")) return pinnedSession("ac_new");
    if (call.url.endsWith("/tool_router/session/sess_1/link")) return LINK_ANSWER;
    throw new Error(`unexpected url ${call.url}`);
  }, calls);

  const broker = createComposioBroker({ apiKey: "sk_test_key", fetcher });
  const result = await broker.createLink(LINK_INPUT);

  assert.equal(result.connectedAccountId, "ca_abc123");
  assert.equal(calls.length, 5);
  assert.deepEqual(calls[1]?.body, {
    toolkit: { slug: "gmail" },
    auth_config: {
      type: "use_composio_managed_auth",
      name: "sourceweft-gmail",
      credentials: { scopes: MAIL_SCOPE },
    },
  });
  assert.deepEqual((calls[3]?.body as { auth_configs?: unknown }).auth_configs, { gmail: "ac_new" });
});

test("createLink refuses a created auth config whose scopes are not the requested ones, and never opens a session", async () => {
  const calls: FakeCall[] = [];
  const fetcher = fakeFetcher((call) => {
    if (isAuthConfigList(call)) return { status: 200, json: { items: [], next_cursor: null } };
    if (call.method === "POST" && call.url.endsWith("/auth_configs")) {
      return { status: 201, json: { auth_config: { id: "ac_new" } } };
    }
    if (call.method === "GET" && call.url.endsWith("/auth_configs/ac_new")) {
      return {
        status: 200,
        json: authConfigItem({
          id: "ac_new",
          credentials: { scopes: [MAIL_SCOPE, "https://www.googleapis.com/auth/userinfo.profile"] },
        }),
      };
    }
    throw new Error(`unexpected url ${call.url}`);
  }, calls);
  const broker = createComposioBroker({ apiKey: "sk_test_key", fetcher });

  await assert.rejects(
    () => broker.createLink(LINK_INPUT),
    (err: unknown) => {
      assert.ok(err instanceof ComposioBrokerError);
      assert.equal(err.code, "COMPOSIO_REQUEST_FAILED" satisfies ComposioBrokerErrorCode);
      assert.match(err.message, /requested scopes/);
      return true;
    },
  );
  assert.equal(calls.length, 3);
});

test("createLink fails with COMPOSIO_AUTH when the key may not create an auth config, and never opens a session", async () => {
  const calls: FakeCall[] = [];
  const fetcher = fakeFetcher((call) => {
    if (isAuthConfigList(call)) return { status: 200, json: { items: [], next_cursor: null } };
    if (call.method === "POST" && call.url.endsWith("/auth_configs")) {
      return { status: 403, json: { error: { slug: "APIKey_InsufficientPermissions", status: 403 } } };
    }
    throw new Error(`unexpected url ${call.url}`);
  }, calls);
  const broker = createComposioBroker({ apiKey: "sk_test_key", fetcher });

  await assert.rejects(
    () => broker.createLink(LINK_INPUT),
    (err: unknown) => {
      assert.ok(err instanceof ComposioBrokerError);
      assert.equal(err.code, "COMPOSIO_AUTH" satisfies ComposioBrokerErrorCode);
      return true;
    },
  );
  assert.equal(calls.length, 2);
});

test("createLink looks the auth config up once per process and reuses it", async () => {
  const calls: FakeCall[] = [];
  const fetcher = fakeFetcher((call) => {
    if (isAuthConfigList(call)) return AUTH_CONFIG_LIST;
    if (call.url.endsWith("/tool_router/session")) return pinnedSession();
    if (call.url.endsWith("/tool_router/session/sess_1/link")) return LINK_ANSWER;
    throw new Error(`unexpected url ${call.url}`);
  }, calls);
  const broker = createComposioBroker({ apiKey: "sk_test_key", fetcher });

  await Promise.all([broker.createLink(LINK_INPUT), broker.createLink(LINK_INPUT)]);
  await broker.createLink(LINK_INPUT);

  assert.equal(calls.filter(isAuthConfigList).length, 1);
  assert.equal(calls.length, 7);
});

test("createLink forgets the auth config after a refused session and looks it up again", async () => {
  const calls: FakeCall[] = [];
  let sessions = 0;
  const fetcher = fakeFetcher((call) => {
    if (isAuthConfigList(call)) return AUTH_CONFIG_LIST;
    if (call.url.endsWith("/tool_router/session")) {
      sessions += 1;
      return sessions === 1 ? { status: 400, json: { error: { slug: "AuthConfig_NotFound" } } } : pinnedSession();
    }
    if (call.url.endsWith("/tool_router/session/sess_1/link")) return LINK_ANSWER;
    throw new Error(`unexpected url ${call.url}`);
  }, calls);
  const broker = createComposioBroker({ apiKey: "sk_test_key", fetcher });

  await assert.rejects(() => broker.createLink(LINK_INPUT));
  await broker.createLink(LINK_INPUT);

  assert.equal(calls.filter(isAuthConfigList).length, 2);
});

test("createLink does not remember a failed auth config lookup", async () => {
  const calls: FakeCall[] = [];
  let lists = 0;
  const fetcher = fakeFetcher((call) => {
    if (isAuthConfigList(call)) {
      lists += 1;
      return lists === 1 ? { status: 503 } : AUTH_CONFIG_LIST;
    }
    if (call.url.endsWith("/tool_router/session")) return pinnedSession();
    if (call.url.endsWith("/tool_router/session/sess_1/link")) return LINK_ANSWER;
    throw new Error(`unexpected url ${call.url}`);
  }, calls);
  const broker = createComposioBroker({ apiKey: "sk_test_key", fetcher });

  await assert.rejects(
    () => broker.createLink(LINK_INPUT),
    (err: unknown) => err instanceof ComposioBrokerError && err.code === "COMPOSIO_UNAVAILABLE",
  );
  const result = await broker.createLink(LINK_INPUT);
  assert.equal(result.connectedAccountId, "ca_abc123");
});

test("createLink reads every page of auth configs and takes the oldest match", async () => {
  const calls: FakeCall[] = [];
  const fetcher = fakeFetcher((call) => {
    if (isAuthConfigList(call)) {
      const cursor = new URL(call.url).searchParams.get("cursor");
      return cursor === "page-2"
        ? {
            status: 200,
            json: {
              items: [authConfigItem({ id: "ac_older", created_at: "2026-11-01T00:00:00.000Z" })],
              next_cursor: null,
            },
          }
        : { status: 200, json: { items: [authConfigItem({ id: "ac_newer" })], next_cursor: "page-2" } };
    }
    if (call.url.endsWith("/tool_router/session")) return pinnedSession("ac_older");
    if (call.url.endsWith("/tool_router/session/sess_1/link")) return LINK_ANSWER;
    throw new Error(`unexpected url ${call.url}`);
  }, calls);
  const broker = createComposioBroker({ apiKey: "sk_test_key", fetcher });

  await broker.createLink(LINK_INPUT);

  assert.equal(calls.filter(isAuthConfigList).length, 2);
  assert.deepEqual((calls[2]?.body as { auth_configs?: unknown }).auth_configs, { gmail: "ac_older" });
});

test("createLink refuses a session that is not pinned to the auth config, and never sends the link request", async () => {
  const calls: FakeCall[] = [];
  const fetcher = fakeFetcher((call) => {
    if (isAuthConfigList(call)) return AUTH_CONFIG_LIST;
    if (call.url.endsWith("/tool_router/session")) {
      return { status: 201, json: { session_id: "sess_1", config: { auth_configs: {} } } };
    }
    throw new Error(`unexpected url ${call.url}`);
  }, calls);
  const broker = createComposioBroker({ apiKey: "sk_test_key", fetcher });

  await assert.rejects(
    () => broker.createLink(LINK_INPUT),
    (err: unknown) => {
      assert.ok(err instanceof ComposioBrokerError);
      assert.equal(err.code, "COMPOSIO_REQUEST_FAILED" satisfies ComposioBrokerErrorCode);
      assert.match(err.message, /not pinned/);
      return true;
    },
  );
  assert.equal(calls.length, 2);
  // The id is not kept after an unpinned session: the next attempt looks again.
  await assert.rejects(() => broker.createLink(LINK_INPUT));
  assert.equal(calls.filter(isAuthConfigList).length, 2);
});

test("createLink sends nothing when no scopes are given", async () => {
  const calls: FakeCall[] = [];
  const fetcher = fakeFetcher(() => {
    throw new Error("no request expected");
  }, calls);
  const broker = createComposioBroker({ apiKey: "sk_test_key", fetcher });

  await assert.rejects(
    () => broker.createLink({ ...LINK_INPUT, scopes: [] }),
    (err: unknown) => err instanceof ComposioBrokerError && err.code === "COMPOSIO_REQUEST_FAILED",
  );
  assert.equal(calls.length, 0);
});

test("an unknown connected account is recognised by Composio's error slug", async () => {
  const calls: FakeCall[] = [];
  const fetcher = fakeFetcher(() => ({
    status: 404,
    json: { error: { message: "Resource missing", slug: "ConnectedAccount_ResourceNotFound", status: 404 } },
  }), calls);
  const broker = createComposioBroker({ apiKey: "sk_test_key", fetcher });

  await assert.rejects(
    () => broker.getConnectedAccount("ca_gone"),
    (err: unknown) =>
      err instanceof ComposioBrokerError && err.code === "COMPOSIO_CONNECTION_INACTIVE",
  );
});

test("proxy maps query/headers into parameters and returns upstream status/data/headers", async () => {
  const calls: FakeCall[] = [];
  const fetcher = fakeFetcher(() => ({
    status: 200,
    json: {
      status: 404,
      data: { error: "not found upstream" },
      headers: { "x-upstream": "1" },
    },
  }), calls);

  const broker = createComposioBroker({ apiKey: "sk_test_key", fetcher });
  const result = await broker.proxy({
    connectedAccountId: "ca_abc123",
    ownerRef: "org_1:user_1",
    url: "/messages",
    method: "GET",
    query: { q: "is:unread" },
    headers: { Accept: "application/json" },
  });

  assert.equal(result.status, 404);
  assert.deepEqual(result.data, { error: "not found upstream" });
  assert.deepEqual(result.headers, { "x-upstream": "1" });

  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call?.url.endsWith("/tools/execute/proxy"), true);
  assert.deepEqual(call?.body, {
    user_id: "org_1:user_1",
    connected_account_id: "ca_abc123",
    endpoint: "/messages",
    method: "GET",
    parameters: [
      { name: "q", value: "is:unread", type: "query" },
      { name: "Accept", value: "application/json", type: "header" },
    ],
  });
});

test("proxy never sends an Authorization parameter even if the caller passes one", async () => {
  const calls: FakeCall[] = [];
  const fetcher = fakeFetcher(() => ({
    status: 200,
    json: { status: 200, data: {}, headers: {} },
  }), calls);

  const broker = createComposioBroker({ apiKey: "sk_test_key", fetcher });
  await broker.proxy({
    connectedAccountId: "ca_abc123",
    ownerRef: "org_1:user_1",
    url: "/messages",
    method: "GET",
    headers: { Authorization: "Bearer stolen", "X-Other": "ok" },
  });

  const body = calls[0]?.body as { parameters: Array<{ name: string }> };
  assert.equal(
    body.parameters.some((p) => p.name.toLowerCase() === "authorization"),
    false,
  );
});

test("a Composio 401 maps to COMPOSIO_AUTH", async () => {
  const calls: FakeCall[] = [];
  const fetcher = fakeFetcher(() => ({ status: 401, json: { message: "invalid key" } }), calls);
  const broker = createComposioBroker({ apiKey: "sk_test_key", fetcher });

  await assert.rejects(
    () => broker.getConnectedAccount("ca_abc123"),
    (err: unknown) => {
      assert.ok(err instanceof ComposioBrokerError);
      assert.equal(err.code, "COMPOSIO_AUTH" satisfies ComposioBrokerErrorCode);
      assert.equal(err.status, 401);
      return true;
    },
  );
});

test("a quota-exhausted answer maps to COMPOSIO_QUOTA", async () => {
  const calls: FakeCall[] = [];
  const fetcher = fakeFetcher(() => ({
    status: 402,
    json: { message: "Plan limit reached: quota exhausted" },
  }), calls);
  const broker = createComposioBroker({ apiKey: "sk_test_key", fetcher });

  await assert.rejects(
    () => broker.getConnectedAccount("ca_abc123"),
    (err: unknown) => {
      assert.ok(err instanceof ComposioBrokerError);
      assert.equal(err.code, "COMPOSIO_QUOTA" satisfies ComposioBrokerErrorCode);
      return true;
    },
  );
});

test("a 503 maps to COMPOSIO_UNAVAILABLE", async () => {
  const calls: FakeCall[] = [];
  const fetcher = fakeFetcher(() => ({ status: 503, json: { message: "down" } }), calls);
  const broker = createComposioBroker({ apiKey: "sk_test_key", fetcher });

  await assert.rejects(
    () => broker.getConnectedAccount("ca_abc123"),
    (err: unknown) => {
      assert.ok(err instanceof ComposioBrokerError);
      assert.equal(err.code, "COMPOSIO_UNAVAILABLE" satisfies ComposioBrokerErrorCode);
      return true;
    },
  );
});

test("a rejected fetch maps to COMPOSIO_UNAVAILABLE", async () => {
  const fetcher = (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
  const broker = createComposioBroker({ apiKey: "sk_test_key", fetcher });

  await assert.rejects(
    () => broker.getConnectedAccount("ca_abc123"),
    (err: unknown) => {
      assert.ok(err instanceof ComposioBrokerError);
      assert.equal(err.code, "COMPOSIO_UNAVAILABLE" satisfies ComposioBrokerErrorCode);
      return true;
    },
  );
});

test("a connected-account-not-found/inactive answer maps to COMPOSIO_CONNECTION_INACTIVE", async () => {
  const calls: FakeCall[] = [];
  const fetcher = fakeFetcher(() => ({
    status: 404,
    json: { message: "Connected account not found or not active" },
  }), calls);
  const broker = createComposioBroker({ apiKey: "sk_test_key", fetcher });

  await assert.rejects(
    () => broker.getConnectedAccount("ca_abc123"),
    (err: unknown) => {
      assert.ok(err instanceof ComposioBrokerError);
      assert.equal(err.code, "COMPOSIO_CONNECTION_INACTIVE" satisfies ComposioBrokerErrorCode);
      return true;
    },
  );
});

test("an undocumented non-2xx status maps to COMPOSIO_REQUEST_FAILED", async () => {
  const calls: FakeCall[] = [];
  const fetcher = fakeFetcher(() => ({ status: 418, json: { message: "I'm a teapot" } }), calls);
  const broker = createComposioBroker({ apiKey: "sk_test_key", fetcher });

  await assert.rejects(
    () => broker.getConnectedAccount("ca_abc123"),
    (err: unknown) => {
      assert.ok(err instanceof ComposioBrokerError);
      assert.equal(err.code, "COMPOSIO_REQUEST_FAILED" satisfies ComposioBrokerErrorCode);
      return true;
    },
  );
});

test("getConnectedAccount reads status and toolkit.slug", async () => {
  const calls: FakeCall[] = [];
  const fetcher = fakeFetcher(() => ({
    status: 200,
    json: { id: "ca_abc123", status: "ACTIVE", toolkit: { slug: "gmail" } },
  }), calls);
  const broker = createComposioBroker({ apiKey: "sk_test_key", fetcher });

  const account = await broker.getConnectedAccount("ca_abc123");
  assert.deepEqual(account, { id: "ca_abc123", status: "ACTIVE", toolkit: "gmail" });
  assert.equal(calls[0]?.url.endsWith("/connected_accounts/ca_abc123"), true);
  assert.equal(calls[0]?.method, "GET");
});

test("deleteConnectedAccount resolves on 404", async () => {
  const calls: FakeCall[] = [];
  const fetcher = fakeFetcher(() => ({ status: 404, json: { message: "not found" } }), calls);
  const broker = createComposioBroker({ apiKey: "sk_test_key", fetcher });

  await assert.doesNotReject(() => broker.deleteConnectedAccount("ca_abc123"));
  assert.equal(calls[0]?.method, "DELETE");
});

test("deleteConnectedAccount throws COMPOSIO_UNAVAILABLE on 500", async () => {
  const calls: FakeCall[] = [];
  const fetcher = fakeFetcher(() => ({ status: 500, json: { message: "boom" } }), calls);
  const broker = createComposioBroker({ apiKey: "sk_test_key", fetcher });

  await assert.rejects(
    () => broker.deleteConnectedAccount("ca_abc123"),
    (err: unknown) => {
      assert.ok(err instanceof ComposioBrokerError);
      assert.equal(err.code, "COMPOSIO_UNAVAILABLE" satisfies ComposioBrokerErrorCode);
      return true;
    },
  );
});

test("deleteConnectedAccount resolves on 204", async () => {
  const calls: FakeCall[] = [];
  const fetcher = fakeFetcher(() => ({ status: 204 }), calls);
  const broker = createComposioBroker({ apiKey: "sk_test_key", fetcher });

  await assert.doesNotReject(() => broker.deleteConnectedAccount("ca_abc123"));
});

test("logs never contain the API key, a ca_ id, the request body or the response body", async () => {
  const calls: FakeCall[] = [];
  const { logger, info, error } = collectingLogger();
  const fetcher = fakeFetcher(() => ({
    status: 401,
    json: { message: "secret response body text ca_leaked_id" },
  }), calls);
  const broker = createComposioBroker({ apiKey: "sk_super_secret_key", fetcher, logger });

  await assert.rejects(() => broker.getConnectedAccount("ca_abc123"));

  const haystacks = [...info, ...error].map(([message, meta]) =>
    JSON.stringify({ message, meta }),
  );
  for (const haystack of haystacks) {
    assert.equal(haystack.includes("sk_super_secret_key"), false);
    assert.equal(haystack.includes("ca_abc123"), false);
    assert.equal(haystack.includes("ca_leaked_id"), false);
    assert.equal(haystack.includes("secret response body text"), false);
  }
  assert.ok(info.length > 0, "expected an info log for the call");
  assert.ok(
    error.some(([message]) => message === "composio_call"),
    "expected an error log for COMPOSIO_AUTH",
  );
});

test("logs one composio_call info entry with operation/status/durationMs on success", async () => {
  const calls: FakeCall[] = [];
  const { logger, info } = collectingLogger();
  const fetcher = fakeFetcher(() => ({
    status: 200,
    json: { id: "ca_abc123", status: "ACTIVE", toolkit: { slug: "gmail" } },
  }), calls);
  const broker = createComposioBroker({ apiKey: "sk_test_key", fetcher, logger });

  await broker.getConnectedAccount("ca_abc123");

  assert.equal(info.length, 1);
  const [message, meta] = info[0]!;
  assert.equal(message, "composio_call");
  assert.equal(meta?.status, 200);
  assert.equal(typeof meta?.durationMs, "number");
  assert.ok(typeof meta?.operation === "string" && (meta.operation as string).length > 0);
});

test("works with no logger at all", async () => {
  const calls: FakeCall[] = [];
  const fetcher = fakeFetcher(() => ({
    status: 200,
    json: { id: "ca_abc123", status: "ACTIVE", toolkit: { slug: "gmail" } },
  }), calls);
  const broker = createComposioBroker({ apiKey: "sk_test_key", fetcher });

  await assert.doesNotReject(() => broker.getConnectedAccount("ca_abc123"));
});

test("works with a logger object that has no info/error methods", async () => {
  const calls: FakeCall[] = [];
  const fetcher = fakeFetcher(() => ({
    status: 200,
    json: { id: "ca_abc123", status: "ACTIVE", toolkit: { slug: "gmail" } },
  }), calls);
  const broker = createComposioBroker({ apiKey: "sk_test_key", fetcher, logger: {} });

  await assert.doesNotReject(() => broker.getConnectedAccount("ca_abc123"));
});

test("a quota-exhausted body on a non-402 status still maps to COMPOSIO_QUOTA via the body heuristic", async () => {
  const calls: FakeCall[] = [];
  const fetcher = fakeFetcher(() => ({
    status: 400,
    json: { message: "Quota exhausted for this project" },
  }), calls);
  const broker = createComposioBroker({ apiKey: "sk_test_key", fetcher });

  await assert.rejects(
    () => broker.getConnectedAccount("ca_abc123"),
    (err: unknown) => {
      assert.ok(err instanceof ComposioBrokerError);
      assert.equal(err.code, "COMPOSIO_QUOTA" satisfies ComposioBrokerErrorCode);
      assert.equal(err.status, 400);
      return true;
    },
  );
});

test("createLink throws COMPOSIO_REQUEST_FAILED when the session answer has no session_id, and never sends the link request", async () => {
  const calls: FakeCall[] = [];
  const fetcher = fakeFetcher((call) => {
    if (isAuthConfigList(call)) return AUTH_CONFIG_LIST;
    if (call.url.endsWith("/tool_router/session")) {
      return { status: 200, json: {} };
    }
    throw new Error(`unexpected second request to ${call.url}`);
  }, calls);
  const broker = createComposioBroker({ apiKey: "sk_test_key", fetcher });

  await assert.rejects(
    () =>
      broker.createLink(LINK_INPUT),
    (err: unknown) => {
      assert.ok(err instanceof ComposioBrokerError);
      assert.equal(err.code, "COMPOSIO_REQUEST_FAILED" satisfies ComposioBrokerErrorCode);
      assert.match(err.message, /session_id/);
      return true;
    },
  );
  assert.equal(calls.length, 2, "the link request must never be sent without a session_id");
});

test("createLink throws COMPOSIO_REQUEST_FAILED when the link answer has no connected_account_id", async () => {
  const calls: FakeCall[] = [];
  const fetcher = fakeFetcher((call) => {
    if (isAuthConfigList(call)) return AUTH_CONFIG_LIST;
    if (call.url.endsWith("/tool_router/session")) return pinnedSession();
    if (call.url.endsWith("/tool_router/session/sess_1/link")) {
      return {
        status: 200,
        json: { redirect_url: "https://connect.composio.dev/link/ln_abc123" },
      };
    }
    throw new Error(`unexpected url ${call.url}`);
  }, calls);
  const broker = createComposioBroker({ apiKey: "sk_test_key", fetcher });

  await assert.rejects(
    () =>
      broker.createLink(LINK_INPUT),
    (err: unknown) => {
      assert.ok(err instanceof ComposioBrokerError);
      assert.equal(err.code, "COMPOSIO_REQUEST_FAILED" satisfies ComposioBrokerErrorCode);
      assert.match(err.message, /connected_account_id/);
      return true;
    },
  );
});

test("createLink throws COMPOSIO_REQUEST_FAILED when the link answer has no redirect_url", async () => {
  const calls: FakeCall[] = [];
  const fetcher = fakeFetcher((call) => {
    if (isAuthConfigList(call)) return AUTH_CONFIG_LIST;
    if (call.url.endsWith("/tool_router/session")) return pinnedSession();
    if (call.url.endsWith("/tool_router/session/sess_1/link")) {
      return {
        status: 200,
        json: { connected_account_id: "ca_abc123" },
      };
    }
    throw new Error(`unexpected url ${call.url}`);
  }, calls);
  const broker = createComposioBroker({ apiKey: "sk_test_key", fetcher });

  await assert.rejects(
    () =>
      broker.createLink(LINK_INPUT),
    (err: unknown) => {
      assert.ok(err instanceof ComposioBrokerError);
      assert.equal(err.code, "COMPOSIO_REQUEST_FAILED" satisfies ComposioBrokerErrorCode);
      assert.match(err.message, /redirect_url/);
      return true;
    },
  );
});

test("getConnectedAccount throws COMPOSIO_REQUEST_FAILED when the answer has no status", async () => {
  const calls: FakeCall[] = [];
  const fetcher = fakeFetcher(() => ({
    status: 200,
    json: { id: "ca_abc123", toolkit: { slug: "gmail" } },
  }), calls);
  const broker = createComposioBroker({ apiKey: "sk_test_key", fetcher });

  await assert.rejects(
    () => broker.getConnectedAccount("ca_abc123"),
    (err: unknown) => {
      assert.ok(err instanceof ComposioBrokerError);
      assert.equal(err.code, "COMPOSIO_REQUEST_FAILED" satisfies ComposioBrokerErrorCode);
      assert.match(err.message, /status/);
      return true;
    },
  );
});

test("getConnectedAccount throws COMPOSIO_REQUEST_FAILED when the answer has no toolkit.slug", async () => {
  const calls: FakeCall[] = [];
  const fetcher = fakeFetcher(() => ({
    status: 200,
    json: { id: "ca_abc123", status: "ACTIVE" },
  }), calls);
  const broker = createComposioBroker({ apiKey: "sk_test_key", fetcher });

  await assert.rejects(
    () => broker.getConnectedAccount("ca_abc123"),
    (err: unknown) => {
      assert.ok(err instanceof ComposioBrokerError);
      assert.equal(err.code, "COMPOSIO_REQUEST_FAILED" satisfies ComposioBrokerErrorCode);
      assert.match(err.message, /toolkit/);
      return true;
    },
  );
});

test("proxy throws COMPOSIO_REQUEST_FAILED when a 200 answer has no numeric status, and never falls back to the HTTP status", async () => {
  const calls: FakeCall[] = [];
  const fetcher = fakeFetcher(() => ({
    status: 200,
    json: { data: { ok: true }, headers: {} },
  }), calls);
  const broker = createComposioBroker({ apiKey: "sk_test_key", fetcher });

  await assert.rejects(
    () =>
      broker.proxy({
        connectedAccountId: "ca_abc123",
        ownerRef: "org_1:user_1",
        url: "/messages",
        method: "GET",
      }),
    (err: unknown) => {
      assert.ok(err instanceof ComposioBrokerError);
      assert.equal(
        err.code,
        "COMPOSIO_REQUEST_FAILED" satisfies ComposioBrokerErrorCode,
      );
      assert.match(err.message, /status/);
      return true;
    },
  );
});

test("the error hook fires for a COMPOSIO_UNAVAILABLE failure, not only auth and quota", async () => {
  const calls: FakeCall[] = [];
  const { logger, error } = collectingLogger();
  const fetcher = fakeFetcher(() => ({ status: 500, json: { message: "boom" } }), calls);
  const broker = createComposioBroker({ apiKey: "sk_test_key", fetcher, logger });

  await assert.rejects(() => broker.getConnectedAccount("ca_abc123"));

  const errorEntry = error.find(([message]) => message === "composio_call");
  assert.ok(errorEntry, "expected an error log for COMPOSIO_UNAVAILABLE");
  assert.equal(errorEntry?.[1]?.code, "COMPOSIO_UNAVAILABLE");
  assert.equal(errorEntry?.[1]?.status, 500);
  assert.equal(typeof errorEntry?.[1]?.operation, "string");
});

test("the error hook fires for a missing-field (COMPOSIO_REQUEST_FAILED) answer", async () => {
  const calls: FakeCall[] = [];
  const { logger, error } = collectingLogger();
  const fetcher = fakeFetcher(() => ({
    status: 200,
    json: { id: "ca_abc123", toolkit: { slug: "gmail" } },
  }), calls);
  const broker = createComposioBroker({ apiKey: "sk_test_key", fetcher, logger });

  await assert.rejects(() => broker.getConnectedAccount("ca_abc123"));

  assert.ok(
    error.some(
      ([message, meta]) =>
        message === "composio_call" &&
        meta?.code === "COMPOSIO_REQUEST_FAILED",
    ),
    "expected an error log for the missing-field failure",
  );
});

test("the error hook fires for a network/timeout (COMPOSIO_UNAVAILABLE) failure", async () => {
  const { logger, error } = collectingLogger();
  const fetcher = (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
  const broker = createComposioBroker({ apiKey: "sk_test_key", fetcher, logger });

  await assert.rejects(() => broker.getConnectedAccount("ca_abc123"));

  assert.ok(
    error.some(
      ([message, meta]) =>
        message === "composio_call" &&
        meta?.code === "COMPOSIO_UNAVAILABLE" &&
        meta?.status === 0,
    ),
    "expected an error log for the network failure",
  );
});

test("ids interpolated into a path are percent-encoded", async () => {
  const calls: FakeCall[] = [];
  const fetcher = fakeFetcher(() => ({
    status: 200,
    json: { id: "ca abc/123", status: "ACTIVE", toolkit: { slug: "gmail" } },
  }), calls);
  const broker = createComposioBroker({ apiKey: "sk_test_key", fetcher });

  await broker.getConnectedAccount("ca abc/123");

  assert.equal(
    calls[0]?.url.endsWith("/connected_accounts/ca%20abc%2F123"),
    true,
  );
});
