import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import { createGmailConnectorAdapter } from "../src/adapter";
import { GMAIL_READ_SCOPE, GMAIL_SEND_SCOPE } from "../src/contribution";

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

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function adapter(fetcher: typeof fetch) {
  return createGmailConnectorAdapter({
    baseUrl: "https://sourceweft.example",
    clientId: "client-id",
    clientSecret: "client-secret",
    fetcher,
  });
}

const context = {
  teamId: "team",
  workspaceId: "workspace",
  connectorId: "connector",
  connectorType: "gmail",
  config: { liveSearchEnabled: true, indexingEnabled: true, maxMessages: 20 },
  accessToken: "access-token",
};

test("indexing waits for a selected label and start date", async () => {
  const gmail = adapter(async () => {
    throw new Error("No provider request is needed for readiness");
  });
  assert.deepEqual(
    await gmail.checkSyncReadiness?.({
      ...context,
      config: { indexingEnabled: true, labelIds: [], maxMessages: 20 },
    }),
    {
      ready: false,
      reason: "gmail_indexing_scope_required",
      message: "Choose Gmail labels and a start date before syncing",
    },
  );
  assert.deepEqual(
    await gmail.checkSyncReadiness?.({
      ...context,
      config: {
        indexingEnabled: true,
        labelIds: ["INBOX"],
        after: "2026-09-01",
        maxMessages: 20,
      },
    }),
    { ready: true },
  );
});

test("OAuth records actual read and send grants and mailbox identity", async () => {
  const gmail = adapter(async (url) => {
    if (String(url).includes("/token")) {
      return json({
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_in: 3600,
        scope: `${GMAIL_READ_SCOPE} ${GMAIL_SEND_SCOPE}`,
      });
    }
    if (String(url).includes("/profile")) {
      return json({ emailAddress: "reader@example.com", historyId: "100" });
    }
    throw new Error("Unexpected request");
  });
  const token = await gmail.exchangeOAuthCode({
    code: "code",
    redirectUri: "https://sourceweft.example/callback",
    scopes: [GMAIL_READ_SCOPE, GMAIL_SEND_SCOPE],
  });
  assert.deepEqual(token.scopes, [GMAIL_READ_SCOPE, GMAIL_SEND_SCOPE]);
  assert.equal(token.providerAccountEmail, "reader@example.com");
  assert.equal(token.refreshToken, "refresh-token");
});

test("OAuth records a declined send grant without assuming requested scopes", async () => {
  const gmail = adapter(async (url) =>
    String(url).includes("/profile")
      ? json({ emailAddress: "reader@example.com", historyId: "100" })
      : json({ access_token: "access-token", scope: GMAIL_READ_SCOPE }),
  );
  const token = await gmail.exchangeOAuthCode({
    code: "code",
    redirectUri: "https://sourceweft.example/callback",
    scopes: [GMAIL_READ_SCOPE, GMAIL_SEND_SCOPE],
  });
  assert.deepEqual(token.scopes, [GMAIL_READ_SCOPE]);
});

test("search is metadata-first and read fetches only the selected body", async () => {
  const calls: string[] = [];
  const gmail = adapter(async (url) => {
    const value = String(url);
    calls.push(value);
    if (value.includes("/profile"))
      return json({ emailAddress: "reader@example.com", historyId: "100" });
    if (value.includes("/messages?"))
      return json({ messages: [{ id: "msg_123", threadId: "thread_123" }] });
    if (value.includes("/messages/msg_123?format=metadata"))
      return json({ ...message, payload: { ...message.payload, parts: [] } });
    if (value.includes("/messages/msg_123?format=full")) return json(message);
    throw new Error("Unexpected request");
  });
  const search = await gmail.executeAction({
    ...context,
    actionType: "gmail.message.search",
    request: { query: "from:author@example.com" },
    idempotencyKey: "search",
  });
  assert.equal(search.result.messages instanceof Array, true);
  assert.equal(
    (search.result.messages as Array<{ citationKey: string }>)[0]?.citationKey,
    "gmail:reader@example.com:msg_123",
  );
  assert.equal(
    JSON.stringify(search.result).includes("Private message body"),
    false,
  );
  const read = await gmail.executeAction({
    ...context,
    actionType: "gmail.message.read",
    request: { messageId: "msg_123" },
    idempotencyKey: "read",
  });
  assert.equal(read.result.body, "Private message body");
  assert.match(String(read.result.url), /mail\.google\.com/);
  assert.equal(
    calls.some((url) => url.includes("format=full")),
    true,
  );
});

test("send formats one plain-text message and returns no body", async () => {
  let sentRaw = "";
  let sendCalls = 0;
  const gmail = adapter(async (url, init) => {
    const value = String(url);
    if (value.includes("/profile"))
      return json({ emailAddress: "reader@example.com", historyId: "100" });
    if (value.endsWith("/messages/send")) {
      sendCalls += 1;
      sentRaw = JSON.parse(String(init?.body)).raw;
      return json({ id: "sent_123", threadId: "thread_456" });
    }
    throw new Error("Unexpected request");
  });
  const result = await gmail.executeAction({
    ...context,
    actionType: "gmail.message.send",
    request: {
      to: ["recipient@example.com"],
      subject: "Hello",
      body: "Private message body",
    },
    idempotencyKey: "send",
  });
  assert.equal(sendCalls, 1);
  assert.match(
    Buffer.from(sentRaw, "base64url").toString("utf8"),
    /To: recipient@example.com/,
  );
  assert.match(
    Buffer.from(sentRaw, "base64url").toString("utf8"),
    /Private message body/,
  );
  assert.equal(JSON.stringify(result).includes("Private message body"), false);
});

test("an uncertain send response is not automatically retried", async () => {
  let sends = 0;
  const gmail = adapter(async (url) => {
    if (String(url).includes("/profile"))
      return json({ emailAddress: "reader@example.com", historyId: "100" });
    if (String(url).endsWith("/messages/send")) {
      sends += 1;
      return json({ error: "unavailable" }, 503);
    }
    throw new Error("Unexpected request");
  });
  await assert.rejects(
    gmail.executeAction({
      ...context,
      actionType: "gmail.message.send",
      request: {
        to: ["recipient@example.com"],
        subject: "Hello",
        body: "Private message body",
      },
      idempotencyKey: "send",
    }),
    { code: "GMAIL_UNAVAILABLE" },
  );
  assert.equal(sends, 1);
});

test("initial indexing yields a durable checkpoint and one message item", async () => {
  const gmail = adapter(async (url) => {
    const value = String(url);
    if (value.includes("/profile"))
      return json({ emailAddress: "reader@example.com", historyId: "100" });
    if (value.includes("/messages?"))
      return json({ messages: [{ id: "msg_123" }] });
    if (value.includes("/messages/msg_123?format=metadata"))
      return json({ ...message, payload: { ...message.payload, parts: [] } });
    throw new Error("Unexpected request");
  });
  const pages = [];
  for await (const page of gmail.discoverPages!({ ...context, cursor: null }))
    pages.push(page);
  assert.equal(pages.length, 1);
  assert.equal(pages[0]?.items[0]?.externalId, "msg_123");
  assert.equal(
    pages[0]?.items[0]?.metadata.citationKey,
    "gmail:reader@example.com:msg_123",
  );
  assert.deepEqual(pages[0]?.checkpoint, { historyId: "100" });
  assert.equal(pages[0]?.reconcileMissing, true);
});

test("history sync reports deletions and commits the new history only at completion", async () => {
  const gmail = adapter(async (url) => {
    const value = String(url);
    if (value.includes("/profile"))
      return json({ emailAddress: "reader@example.com", historyId: "300" });
    if (value.includes("/history")) {
      return json({
        historyId: "300",
        history: [{ messagesDeleted: [{ message: { id: "old_123" } }] }],
      });
    }
    throw new Error("Unexpected request");
  });
  const pages = [];
  for await (const page of gmail.discoverPages!({
    ...context,
    cursor: { committed: { historyId: "100" }, continuation: null },
  }))
    pages.push(page);
  assert.deepEqual(pages[0]?.deletedExternalIds, ["old_123"]);
  assert.deepEqual(pages[0]?.checkpoint, { historyId: "300" });
  assert.equal(pages[0]?.complete, true);
});

test("expired history triggers full reconciliation from a fresh checkpoint", async () => {
  const gmail = adapter(async (url) => {
    const value = String(url);
    if (value.includes("/profile"))
      return json({ emailAddress: "reader@example.com", historyId: "300" });
    if (value.includes("/history")) return json({ error: "expired" }, 404);
    if (value.includes("/messages?")) return json({ messages: [] });
    throw new Error("Unexpected request");
  });
  const pages = [];
  for await (const page of gmail.discoverPages!({
    ...context,
    cursor: {
      committed: { historyId: "100" },
      continuation: {
        mode: "history",
        startHistoryId: "100",
        pageToken: "old-token",
      },
    },
  }))
    pages.push(page);
  assert.deepEqual(pages[0]?.checkpoint, { historyId: "300" });
  assert.equal(pages[0]?.reconcileMissing, true);
});

test("a resumed full scan replays its first page before delete reconciliation", async () => {
  const listPageTokens: Array<string | null> = [];
  const gmail = adapter(async (url) => {
    const value = String(url);
    if (value.includes("/profile"))
      return json({ emailAddress: "reader@example.com", historyId: "400" });
    if (value.includes("/messages?")) {
      listPageTokens.push(new URL(value).searchParams.get("pageToken"));
      return json({ messages: [{ id: "msg_123" }] });
    }
    if (value.includes("/messages/msg_123?format=metadata"))
      return json({ ...message, payload: { ...message.payload, parts: [] } });
    throw new Error("Unexpected request");
  });
  const pages = [];
  for await (const page of gmail.discoverPages!({
    ...context,
    cursor: {
      committed: null,
      continuation: {
        mode: "full",
        startHistoryId: "old",
        pageToken: "second-page",
        selectedCount: 100,
        scanned: 100,
      },
    },
  }))
    pages.push(page);
  assert.deepEqual(listPageTokens, [null]);
  assert.equal(pages[0]?.items[0]?.externalId, "msg_123");
  assert.deepEqual(pages[0]?.checkpoint, { historyId: "400" });
});

test("lost label access stops indexing before reconciliation", async () => {
  const gmail = adapter(async (url) => {
    if (String(url).includes("/labels"))
      return json({ labels: [{ id: "INBOX" }] });
    throw new Error("Unexpected request");
  });
  await assert.rejects(
    async () => {
      for await (const _page of gmail.discoverPages!({
        ...context,
        config: { indexingEnabled: true, labelIds: ["missing"] },
      })) {
        // The adapter must fail before yielding an authoritative empty scan.
      }
    },
    { code: "GMAIL_LABEL_UNAVAILABLE" },
  );
});
