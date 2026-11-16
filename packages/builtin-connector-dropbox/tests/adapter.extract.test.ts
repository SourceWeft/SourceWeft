import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import { isConnectorItemSkipError, type ConnectorExtractInput, type ConnectorItem } from "@sourceweft/contracts";
import { createDropboxConnectorAdapter } from "../src/adapter";
import { DropboxAdapterError } from "../src/dropbox-client";

type FetchCall = { url: string; init: RequestInit };

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Routes a fake fetcher by content endpoint, recording every call so tests
 * can assert on headers (e.g. Dropbox-API-Arg). Unrouted endpoints throw. */
function router(handlers: {
  download?: (call: FetchCall) => Response | Promise<Response>;
  export?: (call: FetchCall) => Response | Promise<Response>;
}) {
  const calls: FetchCall[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const value = String(url);
    const call: FetchCall = { url: value, init: init ?? {} };
    calls.push(call);
    if (value.endsWith("/2/files/download")) {
      if (!handlers.download) throw new Error("Unexpected download call");
      return handlers.download(call);
    }
    if (value.endsWith("/2/files/export")) {
      if (!handlers.export) throw new Error("Unexpected export call");
      return handlers.export(call);
    }
    throw new Error(`Unexpected request: ${value}`);
  }) as typeof fetch;
  return { fetcher, calls };
}

function adapter(fetcher: typeof fetch) {
  return createDropboxConnectorAdapter({
    baseUrl: "https://sourceweft.example",
    clientId: "app-key",
    clientSecret: "app-secret",
    fetcher,
  });
}

function baseItem(overrides: Partial<ConnectorItem> = {}): ConnectorItem {
  return {
    externalId: "file:id:extractfile1",
    externalUri: "https://www.dropbox.com/home?preview=Report.pdf",
    title: "Report.pdf",
    mimeType: "application/pdf",
    sizeBytes: 100,
    externalUpdatedAt: null,
    contentHash: "dropbox:hash1",
    metadata: {
      dropboxFileId: "id:extractfile1",
      pathDisplay: "/Report.pdf",
      pathLower: "/report.pdf",
      rev: "rev1",
      handling: { kind: "download", mimeType: "application/pdf" },
      pathRoot: null,
    },
    ...overrides,
  };
}

function extractInput(item: ConnectorItem): ConnectorExtractInput {
  return {
    teamId: "team",
    workspaceId: "workspace",
    connectorId: "connector",
    connectorType: "dropbox",
    config: { items: [] },
    accessToken: "access-token",
    cursor: null,
    item,
  };
}

test("download descriptor + bytes", async () => {
  const body = Buffer.from("hello world");
  const { fetcher, calls } = router({
    download: () => new Response(body, { status: 200 }),
  });
  const dbx = adapter(fetcher);
  const result = await dbx.extract(extractInput(baseItem()));
  assert.ok("file" in result);
  if (!("file" in result)) return;
  assert.equal(result.file.fileName, "Report.pdf");
  assert.equal(result.file.mimeType, "application/pdf");
  assert.equal(result.file.sizeBytes, 100);
  const bytes = await result.file.download({ maxBytes: 1024 });
  assert.deepEqual(bytes, body);
  const downloadCall = calls.find((call) => call.url.endsWith("/2/files/download"));
  const apiArg = (downloadCall?.init.headers as Record<string, string>)["Dropbox-API-Arg"];
  assert.equal(apiArg, JSON.stringify({ path: "id:extractfile1" }));
});

test("download passes maxBytes through", async () => {
  const body = Buffer.alloc(2048, 65);
  const { fetcher } = router({
    download: () => new Response(body, { status: 200 }),
  });
  const dbx = adapter(fetcher);
  const result = await dbx.extract(extractInput(baseItem()));
  assert.ok("file" in result);
  if (!("file" in result)) return;
  await assert.rejects(
    result.file.download({ maxBytes: 1024 }),
    (error: unknown) => isConnectorItemSkipError(error) && error.reason === "too_large",
  );
});

test("paper export returns markdown text", async () => {
  const { fetcher } = router({
    export: () => new Response("# Notes\n\nSome paper content.", { status: 200 }),
  });
  const dbx = adapter(fetcher);
  const item = baseItem({
    title: "Notes.paper",
    mimeType: "text/markdown",
    sizeBytes: null,
    contentHash: null,
    metadata: {
      dropboxFileId: "id:paperdoc001",
      pathDisplay: "/Notes.paper",
      pathLower: "/notes.paper",
      rev: "rev1",
      handling: { kind: "export_paper", mimeType: "text/markdown" },
      pathRoot: null,
    },
  });
  const result = await dbx.extract(extractInput(item));
  assert.ok("contentText" in result);
  if (!("contentText" in result)) return;
  assert.equal(result.contentText, "# Notes\n\nSome paper content.");
  assert.equal(result.markdown, "# Notes\n\nSome paper content.");
});

test("empty paper export skips empty_content", async () => {
  const { fetcher } = router({
    export: () => new Response("   \n  ", { status: 200 }),
  });
  const dbx = adapter(fetcher);
  const item = baseItem({
    title: "Empty.paper",
    mimeType: "text/markdown",
    sizeBytes: null,
    contentHash: null,
    metadata: {
      dropboxFileId: "id:emptypaper1",
      pathDisplay: "/Empty.paper",
      pathLower: "/empty.paper",
      rev: "rev1",
      handling: { kind: "export_paper", mimeType: "text/markdown" },
      pathRoot: null,
    },
  });
  await assert.rejects(
    dbx.extract(extractInput(item)),
    (error: unknown) => isConnectorItemSkipError(error) && error.reason === "empty_content",
  );
});

test("unsupported skips", async () => {
  const { fetcher, calls } = router({});
  const dbx = adapter(fetcher);
  const item = baseItem({
    title: "Picture.png",
    mimeType: "application/octet-stream",
    metadata: {
      dropboxFileId: "id:unsupported1",
      pathDisplay: "/Picture.png",
      pathLower: "/picture.png",
      rev: "rev1",
      handling: { kind: "unsupported" },
      pathRoot: null,
    },
  });
  await assert.rejects(
    dbx.extract(extractInput(item)),
    (error: unknown) => isConnectorItemSkipError(error) && error.reason === "unsupported_type",
  );
  assert.equal(calls.length, 0);
});

test("invalid metadata id throws DROPBOX_INVALID_ID", async () => {
  const { fetcher } = router({});
  const dbx = adapter(fetcher);
  const item = baseItem({
    metadata: {
      dropboxFileId: "not-a-valid-id",
      pathDisplay: "/Report.pdf",
      pathLower: "/report.pdf",
      rev: "rev1",
      handling: { kind: "download", mimeType: "application/pdf" },
      pathRoot: null,
    },
  });
  await assert.rejects(
    dbx.extract(extractInput(item)),
    (error: unknown) =>
      error instanceof DropboxAdapterError && error.code === "DROPBOX_INVALID_ID",
  );
});

test("exchange maps the account", async () => {
  const dbx = createDropboxConnectorAdapter({
    baseUrl: "https://sourceweft.example",
    clientId: "app-key",
    clientSecret: "app-secret",
    fetcher: (async (url: string | URL | Request) => {
      const value = String(url);
      if (value === "https://api.dropboxapi.com/oauth2/token") {
        return json({
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_in: 3600,
          scope: "account_info.read",
        });
      }
      if (value.endsWith("/2/users/get_current_account")) {
        return json({
          account_id: "dbid:abc123",
          email: "user@example.com",
          name: { display_name: "Pat Example" },
        });
      }
      throw new Error(`Unexpected request: ${value}`);
    }) as typeof fetch,
  });
  const token = await dbx.exchangeOAuthCode({
    code: "auth-code",
    redirectUri: "https://sourceweft.example/v1/connectors/oauth/dropbox/callback",
    scopes: ["account_info.read"],
  });
  assert.equal(token.accessToken, "access-token");
  assert.equal(token.providerAccountId, "dbid:abc123");
  assert.equal(token.providerAccountEmail, "user@example.com");
  assert.equal(token.displayName, "Pat Example");
});

test("exchange falls back to email when display name is absent", async () => {
  const dbx = createDropboxConnectorAdapter({
    baseUrl: "https://sourceweft.example",
    clientId: "app-key",
    clientSecret: "app-secret",
    fetcher: (async (url: string | URL | Request) => {
      const value = String(url);
      if (value === "https://api.dropboxapi.com/oauth2/token") {
        return json({ access_token: "access-token", expires_in: 3600 });
      }
      if (value.endsWith("/2/users/get_current_account")) {
        return json({ account_id: "dbid:xyz", email: "nodisplay@example.com" });
      }
      throw new Error(`Unexpected request: ${value}`);
    }) as typeof fetch,
  });
  const token = await dbx.exchangeOAuthCode({
    code: "auth-code",
    redirectUri: "https://sourceweft.example/v1/connectors/oauth/dropbox/callback",
    scopes: [],
  });
  assert.equal(token.displayName, "nodisplay@example.com");
});

test("refresh delegates to the client", async () => {
  const dbx = createDropboxConnectorAdapter({
    baseUrl: "https://sourceweft.example",
    clientId: "app-key",
    clientSecret: "app-secret",
    fetcher: (async () =>
      json({ access_token: "new-access-token", expires_in: 3600 })) as typeof fetch,
  });
  const token = await dbx.refreshOAuthToken({ refreshToken: "stored-refresh-token", scopes: [] });
  assert.equal(token.accessToken, "new-access-token");
  assert.equal(token.refreshToken, undefined);
});
