import assert from "node:assert/strict";
import test from "node:test";
import { connectorManifestSchema } from "@sourceweft/contracts/connectors";
import type {
  ComposioBroker,
  ProxyInput,
  ProxyResult,
} from "@sourceweft/connector-broker-composio";
import { ComposioBrokerError } from "@sourceweft/connector-broker-composio";
import { createGmailConnectorAdapter } from "../src/adapter";
import { GMAIL_READ_SCOPE, GMAIL_SEND_SCOPE } from "../src/contribution";
import {
  decodeComposioCredential,
  encodeComposioCredential,
} from "../src/transport";

const message = {
  id: "msg_123",
  threadId: "thread_123",
  labelIds: ["INBOX"],
  internalDate: "1770000000000",
  snippet: "A short snippet",
  payload: {
    mimeType: "multipart/alternative",
    headers: [
      { name: "Subject", value: "A topic" },
      { name: "From", value: "Author <author@example.com>" },
      { name: "To", value: "reader@example.com" },
    ],
    parts: [
      {
        mimeType: "text/plain",
        body: {
          data: Buffer.from("Private message body").toString("base64url"),
        },
      },
    ],
  },
};

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** One Gmail-API fixture shared by the google fetch-fake and the Composio
 * proxy-fake, so the two transports are exercised against identical data. */
function gmailFixture(
  url: string,
): { status: number; json: unknown } {
  if (url.includes("/profile"))
    return {
      status: 200,
      json: { emailAddress: "reader@example.com", historyId: "100" },
    };
  if (url.includes("/messages?"))
    return {
      status: 200,
      json: { messages: [{ id: "msg_123", threadId: "thread_123" }] },
    };
  if (url.includes("/messages/msg_123?format=metadata"))
    return {
      status: 200,
      json: { ...message, payload: { ...message.payload, parts: [] } },
    };
  if (url.includes("/messages/msg_123?format=full"))
    return { status: 200, json: message };
  if (url.endsWith("/messages/send"))
    return { status: 200, json: { id: "sent_123", threadId: "thread_456" } };
  if (url.includes("/threads/thread_123?format=full"))
    return { status: 200, json: { messages: [message] } };
  throw new Error(`Unexpected request: ${url}`);
}

function googleAdapter() {
  const fetcher: typeof fetch = async (url) => {
    const { status, json } = gmailFixture(String(url));
    return jsonResponse(json, status);
  };
  return createGmailConnectorAdapter({
    mode: "google",
    baseUrl: "https://sourceweft.example",
    clientId: "client-id",
    clientSecret: "client-secret",
    fetcher,
  });
}

function fakeBroker(overrides: Partial<ComposioBroker> = {}): ComposioBroker {
  return {
    async createLink() {
      throw new Error("createLink is not stubbed for this test");
    },
    async getConnectedAccount() {
      throw new Error("getConnectedAccount is not stubbed for this test");
    },
    async deleteConnectedAccount() {
      throw new Error("deleteConnectedAccount is not stubbed for this test");
    },
    async proxy() {
      throw new Error("proxy is not stubbed for this test");
    },
    ...overrides,
  };
}

function proxyBrokerFromFixture(calls: ProxyInput[]): ComposioBroker {
  return fakeBroker({
    async proxy(input) {
      calls.push(input);
      const { status, json } = gmailFixture(input.url);
      return { status, data: json, headers: {} };
    },
  });
}

function composioAdapter(broker: ComposioBroker) {
  return createGmailConnectorAdapter({
    mode: "composio",
    baseUrl: "https://sourceweft.example",
    broker,
  });
}

const DEFAULT_CREDENTIAL = encodeComposioCredential({
  ownerRef: "ws_workspace",
  connectedAccountId: "ca_1",
});

function actionContext(
  accessToken: string,
  overrides: Partial<{ config: Record<string, unknown> }> = {},
) {
  return {
    teamId: "team",
    workspaceId: "workspace",
    connectorId: "connector",
    connectorType: "gmail",
    config: overrides.config ?? { liveSearchEnabled: true },
    accessToken,
  };
}

function discoverContext(accessToken: string) {
  return {
    teamId: "team",
    workspaceId: "workspace",
    connectorId: "connector",
    connectorType: "gmail",
    config: {},
    accessToken,
    cursor: null,
  };
}

// ---------------------------------------------------------------------------
// Parity: the same Gmail actions through both transports give identical
// results, and Composio never sees a bearer token or anything but an
// absolute Gmail API URL.
// ---------------------------------------------------------------------------

test("search, read, thread, and send give identical results through the Google and Composio transports", async () => {
  const google = googleAdapter();
  const calls: ProxyInput[] = [];
  const composio = composioAdapter(proxyBrokerFromFixture(calls));

  const search = {
    actionType: "gmail.message.search",
    request: { query: "from:author@example.com" },
    idempotencyKey: "search",
  };
  assert.deepEqual(
    await composio.executeAction({
      ...actionContext(DEFAULT_CREDENTIAL),
      ...search,
    }),
    await google.executeAction({ ...actionContext("bearer-token"), ...search }),
  );

  const read = {
    actionType: "gmail.message.read",
    request: { messageId: "msg_123" },
    idempotencyKey: "read",
  };
  assert.deepEqual(
    await composio.executeAction({
      ...actionContext(DEFAULT_CREDENTIAL),
      ...read,
    }),
    await google.executeAction({ ...actionContext("bearer-token"), ...read }),
  );

  const thread = {
    actionType: "gmail.thread.read",
    request: { threadId: "thread_123" },
    idempotencyKey: "thread",
  };
  assert.deepEqual(
    await composio.executeAction({
      ...actionContext(DEFAULT_CREDENTIAL),
      ...thread,
    }),
    await google.executeAction({ ...actionContext("bearer-token"), ...thread }),
  );

  const send = {
    actionType: "gmail.message.send",
    request: {
      to: ["recipient@example.com"],
      subject: "Hello",
      body: "Private message body",
    },
    idempotencyKey: "send",
  };
  assert.deepEqual(
    await composio.executeAction({
      ...actionContext(DEFAULT_CREDENTIAL),
      ...send,
    }),
    await google.executeAction({ ...actionContext("bearer-token"), ...send }),
  );

  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.match(
      call.url,
      /^https:\/\/gmail\.googleapis\.com\/gmail\/v1\/users\/me\//,
    );
    const headerNames = Object.keys(call.headers ?? {}).map((name) =>
      name.toLowerCase(),
    );
    assert.equal(headerNames.includes("authorization"), false);
  }
});

// ---------------------------------------------------------------------------
// Composio-mode authorization lifecycle
// ---------------------------------------------------------------------------

test("startAuthorization opens a Composio link for the gmail toolkit and returns connectedAccountId as attemptRef", async () => {
  let captured: unknown;
  const broker = fakeBroker({
    async createLink(input) {
      captured = input;
      return {
        authorizationUrl: "https://composio.example/authorize/abc",
        connectedAccountId: "ca_1",
      };
    },
  });
  const adapter = composioAdapter(broker);
  const result = await adapter.startAuthorization!({
    callbackUrl: "https://sourceweft.example/callback?state=s",
    ownerRef: "ws_workspace",
  });
  assert.deepEqual(result, {
    authorizationUrl: "https://composio.example/authorize/abc",
    attemptRef: "ca_1",
  });
  // Only the mailbox scope: without it Composio's managed Gmail app would
  // also ask for contacts, addresses, birthday and phone numbers.
  assert.deepEqual(captured, {
    toolkit: "gmail",
    ownerRef: "ws_workspace",
    callbackUrl: "https://sourceweft.example/callback?state=s",
    scopes: ["https://mail.google.com/"],
  });
});

test("finishAuthorization verifies the callback, requires an active gmail account, and returns an encoded credential with read+send scopes", async () => {
  const broker = fakeBroker({
    async getConnectedAccount(id) {
      assert.equal(id, "ca_1");
      return { id: "ca_1", status: "ACTIVE", toolkit: "gmail" };
    },
    async proxy(input) {
      assert.equal(
        input.url,
        "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      );
      return {
        status: 200,
        data: { emailAddress: "reader@example.com", historyId: "100" },
        headers: {},
      };
    },
  });
  const adapter = composioAdapter(broker);
  const token = await adapter.finishAuthorization!({
    callbackParams: { status: "success", connected_account_id: "ca_1" },
    attemptRef: "ca_1",
    ownerRef: "ws_workspace",
  });
  assert.equal(token.providerAccountId, "reader@example.com");
  assert.equal(token.providerAccountEmail, "reader@example.com");
  assert.equal(token.displayName, "reader@example.com");
  assert.deepEqual(token.scopes, [GMAIL_READ_SCOPE, GMAIL_SEND_SCOPE]);
  assert.deepEqual(decodeComposioCredential(token.accessToken), {
    ownerRef: "ws_workspace",
    connectedAccountId: "ca_1",
  });
});

test("finishAuthorization rejects a callback whose connected_account_id does not match the stored attempt", async () => {
  const adapter = composioAdapter(fakeBroker());
  await assert.rejects(
    adapter.finishAuthorization!({
      callbackParams: { status: "success", connected_account_id: "other" },
      attemptRef: "ca_1",
      ownerRef: "ws_workspace",
    }),
    { statusCode: 400, code: "GMAIL_AUTHORIZATION_INVALID" },
  );
});

test("finishAuthorization rejects a callback that reports failure", async () => {
  const adapter = composioAdapter(fakeBroker());
  await assert.rejects(
    adapter.finishAuthorization!({
      callbackParams: { status: "failed", connected_account_id: "ca_1" },
      attemptRef: "ca_1",
      ownerRef: "ws_workspace",
    }),
    { statusCode: 400, code: "GMAIL_AUTHORIZATION_INVALID" },
  );
});

test("finishAuthorization rejects a connected account that is not active", async () => {
  const broker = fakeBroker({
    async getConnectedAccount() {
      return { id: "ca_1", status: "INACTIVE", toolkit: "gmail" };
    },
  });
  const adapter = composioAdapter(broker);
  await assert.rejects(
    adapter.finishAuthorization!({
      callbackParams: { status: "success", connected_account_id: "ca_1" },
      attemptRef: "ca_1",
      ownerRef: "ws_workspace",
    }),
    { statusCode: 409, code: "GMAIL_AUTHORIZATION_INCOMPLETE" },
  );
});

test("finishAuthorization rejects a connected account for a different toolkit", async () => {
  const broker = fakeBroker({
    async getConnectedAccount() {
      return { id: "ca_1", status: "ACTIVE", toolkit: "github" };
    },
  });
  const adapter = composioAdapter(broker);
  await assert.rejects(
    adapter.finishAuthorization!({
      callbackParams: { status: "success", connected_account_id: "ca_1" },
      attemptRef: "ca_1",
      ownerRef: "ws_workspace",
    }),
    { statusCode: 409, code: "GMAIL_AUTHORIZATION_INCOMPLETE" },
  );
});

test("revokeAuthorization deletes the connected account Composio holds", async () => {
  let deletedId: string | undefined;
  const broker = fakeBroker({
    async deleteConnectedAccount(id) {
      deletedId = id;
    },
  });
  const adapter = composioAdapter(broker);
  await adapter.revokeAuthorization!({ accessToken: DEFAULT_CREDENTIAL });
  assert.equal(deletedId, "ca_1");
});

test("startAuthorization translates a Composio broker failure to GMAIL_UNAVAILABLE", async () => {
  const broker = fakeBroker({
    async createLink() {
      throw new ComposioBrokerError("COMPOSIO_QUOTA", 402, "plan limit");
    },
  });
  const adapter = composioAdapter(broker);
  await assert.rejects(
    adapter.startAuthorization!({
      callbackUrl: "https://sourceweft.example/callback?state=s",
      ownerRef: "ws_workspace",
    }),
    { statusCode: 503, code: "GMAIL_UNAVAILABLE" },
  );
});

test("finishAuthorization translates a Composio broker outage to GMAIL_UNAVAILABLE", async () => {
  const broker = fakeBroker({
    async getConnectedAccount() {
      throw new ComposioBrokerError("COMPOSIO_UNAVAILABLE", 503, "down");
    },
  });
  const adapter = composioAdapter(broker);
  await assert.rejects(
    adapter.finishAuthorization!({
      callbackParams: { status: "success", connected_account_id: "ca_1" },
      attemptRef: "ca_1",
      ownerRef: "ws_workspace",
    }),
    { statusCode: 503, code: "GMAIL_UNAVAILABLE" },
  );
});

test("finishAuthorization maps a Composio inactive-connection error to GMAIL_AUTHORIZATION_INCOMPLETE", async () => {
  const broker = fakeBroker({
    async getConnectedAccount() {
      throw new ComposioBrokerError(
        "COMPOSIO_CONNECTION_INACTIVE",
        404,
        "no connected account",
      );
    },
  });
  const adapter = composioAdapter(broker);
  await assert.rejects(
    adapter.finishAuthorization!({
      callbackParams: { status: "success", connected_account_id: "ca_1" },
      attemptRef: "ca_1",
      ownerRef: "ws_workspace",
    }),
    { statusCode: 409, code: "GMAIL_AUTHORIZATION_INCOMPLETE" },
  );
});

test("revokeAuthorization translates a Composio broker failure to GMAIL_UNAVAILABLE", async () => {
  const broker = fakeBroker({
    async deleteConnectedAccount() {
      throw new ComposioBrokerError("COMPOSIO_REQUEST_FAILED", 418, "teapot");
    },
  });
  const adapter = composioAdapter(broker);
  await assert.rejects(
    adapter.revokeAuthorization!({ accessToken: DEFAULT_CREDENTIAL }),
    { statusCode: 503, code: "GMAIL_UNAVAILABLE" },
  );
});

test("composio mode refreshOAuthToken is a terminal reauthorization (401), not a retryable 501", async () => {
  const adapter = composioAdapter(fakeBroker());
  // A 401 is terminal for the platform's refresh-error classifier
  // (isRetryableOAuthRefreshError retries only 429 and >= 500), so the account
  // is marked for reconnection instead of retried forever.
  await assert.rejects(
    adapter.refreshOAuthToken({ refreshToken: "refresh", scopes: [] }),
    { statusCode: 401, code: "GMAIL_REAUTH_REQUIRED" },
  );
});

test("finishAuthorization deletes the just-created connection once when the profile read fails, and surfaces the original error", async () => {
  const deletes: string[] = [];
  const broker = fakeBroker({
    async getConnectedAccount(id) {
      return { id, status: "ACTIVE", toolkit: "gmail" };
    },
    // The profile read (the one proxy call) fails terminally.
    async proxy() {
      throw new ComposioBrokerError(
        "COMPOSIO_CONNECTION_INACTIVE",
        404,
        "no connected account",
      );
    },
    async deleteConnectedAccount(id) {
      deletes.push(id);
    },
  });
  const adapter = composioAdapter(broker);
  await assert.rejects(
    adapter.finishAuthorization!({
      callbackParams: { status: "success", connected_account_id: "ca_1" },
      attemptRef: "ca_1",
      ownerRef: "ws_workspace",
    }),
    { statusCode: 401, code: "GMAIL_REAUTH_REQUIRED" },
  );
  assert.deepEqual(deletes, ["ca_1"]);
});

test("finishAuthorization still surfaces the original profile error when the cleanup delete also fails", async () => {
  const broker = fakeBroker({
    async getConnectedAccount(id) {
      return { id, status: "ACTIVE", toolkit: "gmail" };
    },
    async proxy() {
      throw new ComposioBrokerError(
        "COMPOSIO_CONNECTION_INACTIVE",
        404,
        "no connected account",
      );
    },
    async deleteConnectedAccount() {
      throw new ComposioBrokerError("COMPOSIO_UNAVAILABLE", 503, "down too");
    },
  });
  const adapter = composioAdapter(broker);
  // The original profile failure (GMAIL_REAUTH_REQUIRED), not the cleanup
  // failure, is what surfaces.
  await assert.rejects(
    adapter.finishAuthorization!({
      callbackParams: { status: "success", connected_account_id: "ca_1" },
      attemptRef: "ca_1",
      ownerRef: "ws_workspace",
    }),
    { statusCode: 401, code: "GMAIL_REAUTH_REQUIRED" },
  );
});

test("revokeAuthorization resolves without calling the broker when the credential is not a Composio credential", async () => {
  let deleteCalled = false;
  const broker = fakeBroker({
    async deleteConnectedAccount() {
      deleteCalled = true;
    },
  });
  const adapter = composioAdapter(broker);
  // A Google access token stored before the mode was switched to composio.
  await adapter.revokeAuthorization!({ accessToken: "ya29.google-token" });
  assert.equal(deleteCalled, false);
});

test("composio mode refuses the standard OAuth2 flow and mailbox indexing", async () => {
  const adapter = composioAdapter(fakeBroker());
  await assert.rejects(
    adapter.exchangeOAuthCode({
      code: "code",
      redirectUri: "https://sourceweft.example/callback",
      scopes: [],
    }),
    { statusCode: 501, code: "GMAIL_MODE_UNSUPPORTED" },
  );
  await assert.rejects(
    (async () => {
      for await (const _item of adapter.discover(
        discoverContext(DEFAULT_CREDENTIAL),
      )) {
        // unreachable
      }
    })(),
    { statusCode: 501, code: "GMAIL_MODE_UNSUPPORTED" },
  );
  await assert.rejects(
    (async () => {
      for await (const _page of adapter.discoverPages!(
        discoverContext(DEFAULT_CREDENTIAL),
      )) {
        // unreachable
      }
    })(),
    { statusCode: 501, code: "GMAIL_MODE_UNSUPPORTED" },
  );
  await assert.rejects(
    adapter.extract({
      ...discoverContext(DEFAULT_CREDENTIAL),
      item: {
        externalId: "msg_123",
        externalUri: null,
        title: "A topic",
        mimeType: null,
        sizeBytes: null,
        externalUpdatedAt: null,
        contentHash: null,
        metadata: {},
      },
    }),
    { statusCode: 501, code: "GMAIL_MODE_UNSUPPORTED" },
  );
});

test("checkSyncReadiness always reports indexing unavailable in composio mode", async () => {
  const adapter = composioAdapter(fakeBroker());
  assert.deepEqual(
    await adapter.checkSyncReadiness!(discoverContext(DEFAULT_CREDENTIAL)),
    { ready: false, reason: "indexing_unavailable" },
  );
});

test("the composio manifest uses brokered auth, no sync resources, and a config schema reduced to liveSearchEnabled", () => {
  const adapter = composioAdapter(fakeBroker());
  const manifest = adapter.getManifest();
  assert.equal(manifest.auth.kind, "brokered");
  if (manifest.auth.kind !== "brokered") {
    throw new Error("expected composio manifest to use brokered auth");
  }
  assert.equal(manifest.auth.broker, "composio");
  assert.deepEqual(manifest.sync.resources, []);
  const configProperties = (manifest.configSchema as { properties?: Record<string, unknown> })
    .properties;
  assert.deepEqual(Object.keys(configProperties ?? {}), ["liveSearchEnabled"]);
  connectorManifestSchema.parse(manifest);
});

// ---------------------------------------------------------------------------
// Composio broker error mapping
// ---------------------------------------------------------------------------

test("a Composio inactive-connection error surfaces as GMAIL_REAUTH_REQUIRED", async () => {
  const broker = fakeBroker({
    async proxy() {
      throw new ComposioBrokerError(
        "COMPOSIO_CONNECTION_INACTIVE",
        404,
        "no connected account",
      );
    },
  });
  const adapter = composioAdapter(broker);
  await assert.rejects(
    adapter.executeAction({
      ...actionContext(DEFAULT_CREDENTIAL, { config: {} }),
      actionType: "gmail.labels.list",
      request: {},
      idempotencyKey: "labels",
    }),
    { statusCode: 401, code: "GMAIL_REAUTH_REQUIRED" },
  );
});

test("COMPOSIO_QUOTA on a GET fails after exactly one broker call, without retry", async () => {
  let calls = 0;
  const broker = fakeBroker({
    async proxy() {
      calls += 1;
      throw new ComposioBrokerError("COMPOSIO_QUOTA", 402, "plan limit");
    },
  });
  const adapter = composioAdapter(broker);
  await assert.rejects(
    adapter.executeAction({
      ...actionContext(DEFAULT_CREDENTIAL, { config: {} }),
      actionType: "gmail.labels.list",
      request: {},
      idempotencyKey: "labels",
    }),
    { statusCode: 503, code: "GMAIL_UNAVAILABLE" },
  );
  assert.equal(calls, 1);
});

test("COMPOSIO_UNAVAILABLE on a GET is retried like a network failure, up to three broker calls", async () => {
  let calls = 0;
  const broker = fakeBroker({
    async proxy() {
      calls += 1;
      throw new ComposioBrokerError(
        "COMPOSIO_UNAVAILABLE",
        0,
        "network error or timeout",
      );
    },
  });
  const adapter = composioAdapter(broker);
  await assert.rejects(
    adapter.executeAction({
      ...actionContext(DEFAULT_CREDENTIAL, { config: {} }),
      actionType: "gmail.labels.list",
      request: {},
      idempotencyKey: "labels",
    }),
    { statusCode: 503, code: "GMAIL_UNAVAILABLE" },
  );
  assert.equal(calls, 3);
});

test("COMPOSIO_UNAVAILABLE on the send POST is not retried", async () => {
  const sendCalls: string[] = [];
  const broker = fakeBroker({
    async proxy(input: ProxyInput): Promise<ProxyResult> {
      if (input.url.endsWith("/profile")) {
        return {
          status: 200,
          data: { emailAddress: "reader@example.com", historyId: "100" },
          headers: {},
        };
      }
      sendCalls.push(input.url);
      throw new ComposioBrokerError(
        "COMPOSIO_UNAVAILABLE",
        0,
        "network error or timeout",
      );
    },
  });
  const adapter = composioAdapter(broker);
  await assert.rejects(
    adapter.executeAction({
      ...actionContext(DEFAULT_CREDENTIAL),
      actionType: "gmail.message.send",
      request: {
        to: ["recipient@example.com"],
        subject: "Hello",
        body: "Private message body",
      },
      idempotencyKey: "send",
    }),
    { statusCode: 503, code: "GMAIL_UNAVAILABLE" },
  );
  assert.equal(sendCalls.length, 1);
});

test("a non-numeric Composio proxy status is treated as a failed call, not retried", async () => {
  let calls = 0;
  const broker = fakeBroker({
    async proxy() {
      calls += 1;
      return {
        status: undefined as unknown as number,
        data: null,
        headers: {},
      };
    },
  });
  const adapter = composioAdapter(broker);
  await assert.rejects(
    adapter.executeAction({
      ...actionContext(DEFAULT_CREDENTIAL, { config: {} }),
      actionType: "gmail.labels.list",
      request: {},
      idempotencyKey: "labels",
    }),
    { statusCode: 503, code: "GMAIL_UNAVAILABLE" },
  );
  assert.equal(calls, 1);
});

// ---------------------------------------------------------------------------
// Missing COMPOSIO_API_KEY (broker: null)
// ---------------------------------------------------------------------------

test("every composio-mode method that needs the broker throws CONNECTOR_OAUTH_CONFIG_MISSING when it is null", async () => {
  const adapter = createGmailConnectorAdapter({
    mode: "composio",
    baseUrl: "https://sourceweft.example",
    broker: null,
  });
  await assert.rejects(
    adapter.startAuthorization!({
      callbackUrl: "https://sourceweft.example/callback",
      ownerRef: "ws_workspace",
    }),
    { statusCode: 500, code: "CONNECTOR_OAUTH_CONFIG_MISSING" },
  );
  await assert.rejects(
    adapter.finishAuthorization!({
      callbackParams: { status: "success", connected_account_id: "ca_1" },
      attemptRef: "ca_1",
      ownerRef: "ws_workspace",
    }),
    { statusCode: 500, code: "CONNECTOR_OAUTH_CONFIG_MISSING" },
  );
  await assert.rejects(
    adapter.revokeAuthorization!({ accessToken: DEFAULT_CREDENTIAL }),
    { statusCode: 500, code: "CONNECTOR_OAUTH_CONFIG_MISSING" },
  );
  await assert.rejects(
    adapter.executeAction({
      ...actionContext(DEFAULT_CREDENTIAL, { config: {} }),
      actionType: "gmail.labels.list",
      request: {},
      idempotencyKey: "labels",
    }),
    { statusCode: 500, code: "CONNECTOR_OAUTH_CONFIG_MISSING" },
  );
});
