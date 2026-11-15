import assert from "node:assert/strict";
import test from "node:test";
import { isConnectorItemSkipError } from "@sourceweft/contracts";
import {
  DropboxAdapterError,
  assertDropboxId,
  createDropboxClient,
  dropboxApiArg,
} from "../src/dropbox-client";

type RecordedCall = { url: string; init: RequestInit };

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function dropbox(fetcher: typeof fetch) {
  return createDropboxClient({
    clientId: "app-key",
    clientSecret: "app-secret",
    fetcher,
  });
}

function recordingFetcher(handler: (call: RecordedCall) => Response | Promise<Response>) {
  const calls: RecordedCall[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { fetcher, calls };
}

test("exchangeAuthorizationCode posts the form and maps the token", async () => {
  let tokenBody = new URLSearchParams();
  let tokenHeaders: HeadersInit | undefined;
  const client = dropbox(async (url, init) => {
    assert.equal(String(url), "https://api.dropboxapi.com/oauth2/token");
    tokenBody = new URLSearchParams(String(init?.body));
    tokenHeaders = init?.headers;
    return json({
      access_token: "access-token",
      refresh_token: "refresh-token",
      expires_in: 3600,
      scope: "account_info.read files.metadata.read",
      account_id: "dbid:abc",
    });
  });

  const before = Date.now();
  const token = await client.exchangeAuthorizationCode(
    "auth-code",
    "https://sourceweft.example/v1/connectors/oauth/dropbox/callback",
  );

  assert.equal(tokenBody.get("grant_type"), "authorization_code");
  assert.equal(tokenBody.get("code"), "auth-code");
  assert.equal(
    tokenBody.get("redirect_uri"),
    "https://sourceweft.example/v1/connectors/oauth/dropbox/callback",
  );
  assert.equal(tokenBody.get("client_id"), "app-key");
  assert.equal(tokenBody.get("client_secret"), "app-secret");
  assert.equal(
    (tokenHeaders as Record<string, string>)["Content-Type"],
    "application/x-www-form-urlencoded",
  );

  assert.equal(token.accessToken, "access-token");
  assert.equal(token.refreshToken, "refresh-token");
  assert.deepEqual(token.scopes, ["account_info.read", "files.metadata.read"]);
  assert.ok(token.expiresAt instanceof Date);
  assert.ok(token.expiresAt!.getTime() >= before + 3600 * 1000);
});

test("refresh keeps the stored refresh token", async () => {
  const client = dropbox(async () =>
    json({
      access_token: "new-access-token",
      expires_in: 3600,
      scope: "account_info.read",
    }),
  );

  const token = await client.refreshAccessToken("stored-refresh-token");

  assert.equal(token.accessToken, "new-access-token");
  assert.equal(token.refreshToken, undefined);
});

test("token endpoint 400 is DROPBOX_REAUTH_REQUIRED", async () => {
  const client = dropbox(async () => json({ error: "invalid_grant" }, 400));

  await assert.rejects(client.refreshAccessToken("expired-refresh-token"), (error) => {
    assert.ok(error instanceof DropboxAdapterError);
    assert.equal(error.statusCode, 400);
    assert.equal(error.code, "DROPBOX_REAUTH_REQUIRED");
    return true;
  });
});

test("path root header only for team accounts", async () => {
  const { fetcher, calls } = recordingFetcher(() =>
    json({ ".tag": "file", id: "id:abc123", name: "Report.pdf" }),
  );
  const client = dropbox(fetcher);

  await client.getMetadata("access-token", null, "id:abc123");
  assert.equal(
    (calls[0]?.init.headers as Record<string, string>)["Dropbox-API-Path-Root"],
    undefined,
  );

  await client.getMetadata("access-token", "ns1", "id:abc123");
  assert.equal(
    (calls[1]?.init.headers as Record<string, string>)["Dropbox-API-Path-Root"],
    '{".tag":"root","root":"ns1"}',
  );
});

test("dropboxApiArg escapes non-ASCII", () => {
  const encoded = dropboxApiArg({ path: "/工作" });
  assert.equal(encoded, '{"path":"/\\u5de5\\u4f5c"}');
  assert.ok(/^[\x00-\x7f]*$/.test(encoded));
});

test("getMetadata not_found returns null", async () => {
  const client = dropbox(async () =>
    json(
      {
        error_summary: "path/not_found/..",
        error: { ".tag": "path", path: { ".tag": "not_found" } },
      },
      409,
    ),
  );

  const entry = await client.getMetadata("access-token", null, "id:gone0000001");
  assert.equal(entry, null);
});

test("listFolder not_folder returns null", async () => {
  const client = dropbox(async () =>
    json(
      {
        error_summary: "path/not_folder/..",
        error: { ".tag": "path", path: { ".tag": "not_folder" } },
      },
      409,
    ),
  );

  const listing = await client.listFolder("access-token", null, {
    path: "id:notafolder1",
    recursive: false,
    limit: 2000,
  });
  assert.equal(listing, null);
});

test("continue reset is retryable 503", async () => {
  const client = dropbox(async () =>
    json(
      {
        error_summary: "reset/..",
        error: { ".tag": "reset" },
      },
      409,
    ),
  );

  await assert.rejects(client.listFolderContinue("access-token", null, "cursor-1"), (error) => {
    assert.ok(error instanceof DropboxAdapterError);
    assert.equal(error.statusCode, 503);
    assert.equal(error.code, "DROPBOX_CURSOR_RESET");
    return true;
  });
});

test("maps a 401 to DROPBOX_REAUTH_REQUIRED", async () => {
  const client = dropbox(async () => json({ error_summary: "invalid_access_token/.." }, 401));

  await assert.rejects(client.getCurrentAccount("access-token"), (error) => {
    assert.ok(error instanceof DropboxAdapterError);
    assert.equal(error.statusCode, 401);
    assert.equal(error.code, "DROPBOX_REAUTH_REQUIRED");
    return true;
  });
});

test("maps a 429 to DROPBOX_RATE_LIMITED", async () => {
  const client = dropbox(async () => json({ error_summary: "too_many_requests/.." }, 429));

  await assert.rejects(client.getCurrentAccount("access-token"), (error) => {
    assert.ok(error instanceof DropboxAdapterError);
    assert.equal(error.statusCode, 429);
    assert.equal(error.code, "DROPBOX_RATE_LIMITED");
    return true;
  });
});

test("maps a 500 to DROPBOX_UNAVAILABLE", async () => {
  const client = dropbox(async () => json({ error_summary: "internal_error/.." }, 500));

  await assert.rejects(client.getCurrentAccount("access-token"), (error) => {
    assert.ok(error instanceof DropboxAdapterError);
    assert.equal(error.statusCode, 503);
    assert.equal(error.code, "DROPBOX_UNAVAILABLE");
    return true;
  });
});

test("maps a network error to DROPBOX_UNAVAILABLE", async () => {
  const client = dropbox(async () => {
    throw new TypeError("fetch failed");
  });

  await assert.rejects(client.getCurrentAccount("access-token"), (error) => {
    assert.ok(error instanceof DropboxAdapterError);
    assert.equal(error.statusCode, 503);
    assert.equal(error.code, "DROPBOX_UNAVAILABLE");
    return true;
  });
});

test("download restricted_content skips unreadable", async () => {
  const client = dropbox(async () =>
    json(
      {
        error_summary: "path/restricted_content/..",
        error: { ".tag": "path", path: { ".tag": "restricted_content" } },
      },
      409,
    ),
  );

  await assert.rejects(
    client.downloadBytes("access-token", null, "id:restricted01", 1024),
    (error) => {
      assert.ok(isConnectorItemSkipError(error));
      assert.equal((error as { reason: string }).reason, "unreadable");
      return true;
    },
  );
});

test("export non_exportable skips unsupported_type", async () => {
  const client = dropbox(async () =>
    json(
      {
        error_summary: "path/non_exportable/..",
        error: { ".tag": "path", path: { ".tag": "non_exportable" } },
      },
      409,
    ),
  );

  await assert.rejects(client.exportPaperMarkdown("access-token", null, "id:paperdoc001"), (error) => {
    assert.ok(isConnectorItemSkipError(error));
    assert.equal((error as { reason: string }).reason, "unsupported_type");
    return true;
  });
});

test("download not_found maps to 404 DROPBOX_NOT_FOUND", async () => {
  const client = dropbox(async () =>
    json(
      {
        error_summary: "path/not_found/..",
        error: { ".tag": "path", path: { ".tag": "not_found" } },
      },
      409,
    ),
  );

  await assert.rejects(client.downloadBytes("access-token", null, "id:gone0000002", 1024), (error) => {
    assert.ok(error instanceof DropboxAdapterError);
    assert.equal(error.statusCode, 404);
    assert.equal(error.code, "DROPBOX_NOT_FOUND");
    return true;
  });
});

test("export reads the body through the capped reader", async () => {
  const client = dropbox(async () => new Response("# Hello\n", { status: 200 }));

  const markdown = await client.exportPaperMarkdown(
    "access-token",
    null,
    "id:paperdoc002",
  );
  assert.equal(markdown, "# Hello\n");
});

test("export over the 20 MB cap skips export_too_large", async () => {
  const bigBody = Buffer.alloc(20 * 1024 * 1024 + 1, 65);
  const client = dropbox(async () => new Response(bigBody, { status: 200 }));

  await assert.rejects(
    client.exportPaperMarkdown("access-token", null, "id:paperdoc003"),
    (error) => {
      assert.ok(isConnectorItemSkipError(error));
      assert.equal((error as { reason: string }).reason, "export_too_large");
      return true;
    },
  );
});

test("download over maxBytes skips too_large", async () => {
  const bigBody = Buffer.alloc(2048, 65);
  const client = dropbox(async () => new Response(bigBody, { status: 200 }));

  await assert.rejects(client.downloadBytes("access-token", null, "id:toolarge001", 1024), (error) => {
    assert.ok(isConnectorItemSkipError(error));
    assert.equal((error as { reason: string }).reason, "too_large");
    return true;
  });
});

test("error messages carry no token", async () => {
  const token = "super-secret-access-token";
  const client = dropbox(async () => json({ error_summary: "invalid_access_token/.." }, 401));

  await assert.rejects(client.getCurrentAccount(token), (error) => {
    assert.ok(error instanceof Error);
    assert.ok(!error.message.includes(token));
    assert.ok(!(error.stack ?? "").includes(token));
    return true;
  });
});

test("assertDropboxId rejects path-like ids", () => {
  assert.throws(() => assertDropboxId("/a"), DropboxAdapterError);
  assert.throws(() => assertDropboxId("id:../x"), DropboxAdapterError);
  assert.throws(() => assertDropboxId("id:"), DropboxAdapterError);
});

test("assertDropboxId accepts a well-formed id", () => {
  assert.equal(assertDropboxId("id:abc123_ABC-1"), "id:abc123_ABC-1");
});
