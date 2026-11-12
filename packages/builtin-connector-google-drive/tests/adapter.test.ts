import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import {
  ConnectorItemSkipError,
  isConnectorExtractedFile,
  type ConnectorDiscoverInput,
  type ConnectorExtractedFile,
  type ConnectorExtractedText,
  type ConnectorItem,
} from "@sourceweft/contracts";
import { createGoogleDriveConnectorAdapter } from "../src/adapter";
import { GOOGLE_DRIVE_FILE_SCOPE } from "../src/contribution";

const GOOGLE_DOC = "application/vnd.google-apps.document";
const GOOGLE_SLIDES = "application/vnd.google-apps.presentation";
const GOOGLE_SHEET = "application/vnd.google-apps.spreadsheet";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function adapter(fetcher: typeof fetch) {
  return createGoogleDriveConnectorAdapter({
    baseUrl: "https://sourceweft.example",
    clientId: "123456789-x.apps.googleusercontent.com",
    clientSecret: "client-secret",
    pickerApiKey: "picker-key",
    fetcher,
  });
}

const context = {
  teamId: "team",
  workspaceId: "workspace",
  connectorId: "connector",
  connectorType: "google_drive",
  config: { fileIds: [] as string[] },
  accessToken: "access-token",
};

function driveItem(
  metadata: { driveFileId: string; driveMimeType: string },
  overrides: Partial<ConnectorItem> = {},
): ConnectorItem {
  return {
    externalId: `file:${metadata.driveFileId}`,
    externalUri: "https://drive.google.com/file",
    title: "Title",
    mimeType: "application/octet-stream",
    sizeBytes: null,
    externalUpdatedAt: null,
    contentHash: null,
    metadata,
    ...overrides,
  };
}

async function collectItems(
  iterable: AsyncIterable<{ items: ConnectorItem[] }>,
): Promise<ConnectorItem[]> {
  const items: ConnectorItem[] = [];
  for await (const page of iterable) items.push(...page.items);
  return items;
}

function metadataFor(url: string, overrides: Record<string, unknown> = {}) {
  const id = new URL(url).pathname.split("/").pop() ?? "";
  return json({
    id,
    name: "File",
    mimeType: "application/pdf",
    md5Checksum: "hash",
    size: "100",
    webViewLink: `https://drive.google.com/${id}`,
    modifiedTime: "2026-01-01T00:00:00Z",
    ...overrides,
  });
}

test("exchanges a code and reads the account from about.get", async () => {
  let tokenBody = new URLSearchParams();
  const gdrive = adapter(async (url, init) => {
    const value = String(url);
    if (value.includes("/token")) {
      tokenBody = new URLSearchParams(String(init?.body));
      return json({
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_in: 3600,
        scope: GOOGLE_DRIVE_FILE_SCOPE,
      });
    }
    if (value.includes("/about")) {
      return json({
        user: {
          emailAddress: "owner@example.com",
          displayName: "Owner",
          permissionId: "perm-1",
        },
      });
    }
    throw new Error("Unexpected request");
  });
  const token = await gdrive.exchangeOAuthCode({
    code: "code",
    redirectUri:
      "https://sourceweft.example/v1/connectors/oauth/google_drive/callback",
    scopes: [GOOGLE_DRIVE_FILE_SCOPE],
  });
  assert.equal(token.providerAccountId, "perm-1");
  assert.equal(token.providerAccountEmail, "owner@example.com");
  assert.equal(token.refreshToken, "refresh-token");
  assert.equal(
    tokenBody.get("redirect_uri"),
    "https://sourceweft.example/v1/connectors/oauth/google_drive/callback",
  );
});

test("maps invalid_grant on refresh to a non-retryable OAuth failure", async () => {
  const gdrive = adapter(async () => json({ error: "invalid_grant" }, 400));
  await assert.rejects(
    gdrive.refreshOAuthToken({
      refreshToken: "refresh-token",
      scopes: [GOOGLE_DRIVE_FILE_SCOPE],
    }),
    { statusCode: 401, code: "GOOGLE_DRIVE_OAUTH_FAILED" },
  );
});

test("maps a 401 from the API to reauth", async () => {
  const gdrive = adapter(async () => json({ error: { code: 401 } }, 401));
  await assert.rejects(
    collectItems(
      gdrive.discoverPages!({
        ...context,
        config: { fileIds: ["filereauth01"] },
        cursor: null,
      }),
    ),
    { statusCode: 401, code: "GOOGLE_DRIVE_REAUTH_REQUIRED" },
  );
});

test("rejects a malformed file id before any request", async () => {
  let calls = 0;
  const gdrive = adapter(async () => {
    calls += 1;
    return json({});
  });
  await assert.rejects(
    collectItems(
      gdrive.discoverPages!({
        ...context,
        config: { fileIds: ["../x"] },
        cursor: null,
      }),
    ),
    { code: "GOOGLE_DRIVE_INVALID_ID" },
  );
  assert.equal(calls, 0);
});

test("yields one empty reconciling page when nothing is selected", async () => {
  let calls = 0;
  const gdrive = adapter(async () => {
    calls += 1;
    return json({});
  });
  const pages = [];
  for await (const page of gdrive.discoverPages!({
    ...context,
    config: { fileIds: [] },
    cursor: null,
  })) {
    pages.push(page);
  }
  assert.equal(pages.length, 1);
  assert.deepEqual(pages[0]?.items, []);
  assert.equal(pages[0]?.complete, true);
  assert.equal(pages[0]?.reconcileMissing, true);
  assert.equal(calls, 0);
});

test("pages 50 files at a time and resumes from the continuation", async () => {
  const ids = Array.from(
    { length: 120 },
    (_, i) => `drivefile${String(i).padStart(4, "0")}`,
  );
  let calls = 0;
  const gdrive = adapter(async (url) => {
    calls += 1;
    return metadataFor(String(url));
  });
  const pages = [];
  for await (const page of gdrive.discoverPages!({
    ...context,
    config: { fileIds: ids },
    cursor: null,
  })) {
    pages.push(page);
  }
  assert.equal(pages.length, 3);
  assert.equal(pages[0]?.items.length, 50);
  assert.equal(pages[1]?.items.length, 50);
  assert.equal(pages[2]?.items.length, 20);
  assert.deepEqual(pages[0]?.continuation, { offset: 50 });
  assert.equal(pages[0]?.reconcileMissing, false);
  assert.deepEqual(pages[1]?.continuation, { offset: 100 });
  assert.equal(pages[1]?.reconcileMissing, false);
  assert.equal(pages[2]?.complete, true);
  assert.equal(pages[2]?.continuation, null);
  assert.equal(pages[2]?.reconcileMissing, true);

  calls = 0;
  const resumed = [];
  for await (const page of gdrive.discoverPages!({
    ...context,
    config: { fileIds: ids },
    cursor: { continuation: { offset: 100 } },
  })) {
    resumed.push(page);
  }
  assert.equal(calls, 20);
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0]?.items.length, 20);
});

test("omits trashed and missing files so reconcile archives them", async () => {
  const ids = ["filenormal01", "filetrashed1", "filemissing1"];
  const gdrive = adapter(async (url) => {
    const value = String(url);
    if (value.includes("filetrashed1")) {
      return json({ id: "filetrashed1", mimeType: "application/pdf", trashed: true });
    }
    if (value.includes("filemissing1")) {
      return json({ error: { code: 404 } }, 404);
    }
    return metadataFor(value);
  });
  const pages = [];
  for await (const page of gdrive.discoverPages!({
    ...context,
    config: { fileIds: ids },
    cursor: null,
  })) {
    pages.push(page);
  }
  assert.equal(pages.length, 1);
  assert.equal(pages[0]?.items.length, 1);
  assert.equal(pages[0]?.items[0]?.externalId, "file:filenormal01");
  assert.equal(pages[0]?.reconcileMissing, true);
});

test("fails the page on 429 instead of treating the file as missing", async () => {
  const gdrive = adapter(async () => json({ error: { code: 429 } }, 429));
  const pages = [];
  await assert.rejects(
    (async () => {
      for await (const page of gdrive.discoverPages!({
        ...context,
        config: { fileIds: ["file42900001"] },
        cursor: null,
      })) {
        pages.push(page);
      }
    })(),
    { statusCode: 429, code: "GOOGLE_DRIVE_RATE_LIMITED" },
  );
  assert.equal(pages.length, 0);
});

test("fails the page on 500", async () => {
  const gdrive = adapter(async () => json({ error: { code: 500 } }, 500));
  await assert.rejects(
    collectItems(
      gdrive.discoverPages!({
        ...context,
        config: { fileIds: ["file50000001"] },
        cursor: null,
      }),
    ),
    { statusCode: 503, code: "GOOGLE_DRIVE_UNAVAILABLE" },
  );
});

test("hashes binaries by md5 and leaves native files unhashed", async () => {
  const ids = ["filepdf00001", "filedoc00001"];
  const gdrive = adapter(async (url) => {
    const value = String(url);
    if (value.includes("filepdf00001")) {
      return json({
        id: "filepdf00001",
        name: "Doc.pdf",
        mimeType: "application/pdf",
        md5Checksum: "abc",
        size: "100",
        webViewLink: "https://drive.google.com/pdf",
        modifiedTime: "2026-01-01T00:00:00Z",
      });
    }
    return json({
      id: "filedoc00001",
      name: "Notes",
      mimeType: GOOGLE_DOC,
      webViewLink: "https://drive.google.com/doc",
      modifiedTime: "2026-01-01T00:00:00Z",
    });
  });
  const items = await collectItems(
    gdrive.discoverPages!({
      ...context,
      config: { fileIds: ids },
      cursor: null,
    }),
  );
  const pdf = items.find((i) => i.externalId === "file:filepdf00001");
  const doc = items.find((i) => i.externalId === "file:filedoc00001");
  assert.equal(pdf?.contentHash, "md5:abc");
  assert.equal(doc?.contentHash, null);
  assert.equal(doc?.mimeType, "text/markdown");
});

test("keeps the hash and reports the new title when a file is only renamed", async () => {
  const before = adapter(async () =>
    json({
      id: "filerename01",
      name: "Old name",
      mimeType: "application/pdf",
      md5Checksum: "same",
      size: "10",
      webViewLink: "https://drive.google.com/x",
      modifiedTime: "2026-01-01T00:00:00Z",
    }),
  );
  const after = adapter(async () =>
    json({
      id: "filerename01",
      name: "New name",
      mimeType: "application/pdf",
      md5Checksum: "same",
      size: "10",
      webViewLink: "https://drive.google.com/x",
      modifiedTime: "2026-02-01T00:00:00Z",
    }),
  );
  const first = await collectItems(
    before.discoverPages!({
      ...context,
      config: { fileIds: ["filerename01"] },
      cursor: null,
    }),
  );
  const second = await collectItems(
    after.discoverPages!({
      ...context,
      config: { fileIds: ["filerename01"] },
      cursor: null,
    }),
  );
  assert.equal(first[0]?.contentHash, "md5:same");
  assert.equal(second[0]?.contentHash, first[0]?.contentHash);
  assert.equal(second[0]?.title, "New name");
});

test("exports a Google Doc as markdown", async () => {
  let exportUrl = "";
  const item = driveItem(
    { driveFileId: "filedoc00001", driveMimeType: GOOGLE_DOC },
    { title: "Doc" },
  );
  const gdrive = adapter(async (url) => {
    exportUrl = String(url);
    return new Response("# Title", { status: 200 });
  });
  const content = await gdrive.extract({ ...context, item });
  assert.equal((content as ConnectorExtractedText).markdown, "# Title");
  assert.equal((content as ConnectorExtractedText).contentText, "# Title");
  assert.match(exportUrl, /mimeType=text%2Fmarkdown/);
});

test("exports Slides as plain text", async () => {
  const item = driveItem(
    { driveFileId: "fileslide001", driveMimeType: GOOGLE_SLIDES },
    { title: "Deck" },
  );
  const gdrive = adapter(async () => new Response("Slide text", { status: 200 }));
  const content = await gdrive.extract({ ...context, item });
  assert.equal((content as ConnectorExtractedText).contentText, "Slide text");
  assert.equal((content as ConnectorExtractedText).markdown, undefined);
});

test("returns a Sheet as an xlsx file descriptor", async () => {
  const item = driveItem(
    { driveFileId: "filesheet001", driveMimeType: GOOGLE_SHEET },
    { title: "Budget" },
  );
  const gdrive = adapter(
    async () => new Response(Buffer.from("xlsx-bytes"), { status: 200 }),
  );
  const content = await gdrive.extract({ ...context, item });
  assert.equal(isConnectorExtractedFile(content), true);
  const file = (content as ConnectorExtractedFile).file;
  assert.equal(file.fileName, "Budget.xlsx");
  assert.equal(file.mimeType, XLSX);
  assert.equal(file.sizeBytes, null);
  const bytes = await file.download({ maxBytes: 20_000_000 });
  assert.equal(bytes.toString(), "xlsx-bytes");
});

test("returns an extensionless PDF as a download descriptor", async () => {
  const item = driveItem(
    { driveFileId: "filepdf00002", driveMimeType: "application/pdf" },
    { title: "Q3 report", sizeBytes: 100 },
  );
  const gdrive = adapter(async () => new Response(Buffer.from("pdf"), { status: 200 }));
  const content = await gdrive.extract({ ...context, item });
  const file = (content as ConnectorExtractedFile).file;
  assert.equal(file.fileName, "Q3 report");
  assert.equal(file.mimeType, "application/pdf");
});

test("skips a blank Google Doc", async () => {
  const item = driveItem(
    { driveFileId: "fileblank001", driveMimeType: GOOGLE_DOC },
    { title: "Blank" },
  );
  const gdrive = adapter(async () => new Response("\n", { status: 200 }));
  await assert.rejects(
    gdrive.extract({ ...context, item }),
    (error: unknown) =>
      error instanceof ConnectorItemSkipError && error.reason === "empty_content",
  );
});

test("skips an unsupported type", async () => {
  let calls = 0;
  const item = driveItem(
    { driveFileId: "fileimage001", driveMimeType: "image/png" },
    { title: "Pic" },
  );
  const gdrive = adapter(async () => {
    calls += 1;
    return new Response("x", { status: 200 });
  });
  await assert.rejects(
    gdrive.extract({ ...context, item }),
    (error: unknown) =>
      error instanceof ConnectorItemSkipError &&
      error.reason === "unsupported_type",
  );
  assert.equal(calls, 0);
});

test("skips an export over Google's limit", async () => {
  const item = driveItem(
    { driveFileId: "filebigdoc01", driveMimeType: GOOGLE_DOC },
    { title: "Big" },
  );
  const gdrive = adapter(async () =>
    json({ error: { errors: [{ reason: "exportSizeLimitExceeded" }] } }, 403),
  );
  await assert.rejects(
    gdrive.extract({ ...context, item }),
    (error: unknown) =>
      error instanceof ConnectorItemSkipError &&
      error.reason === "export_too_large",
  );
});

test("refuses a download over maxBytes", async () => {
  const item = driveItem(
    { driveFileId: "filebigpdf01", driveMimeType: "application/pdf" },
    { title: "Big PDF" },
  );
  const gdrive = adapter(
    async () =>
      new Response("partial", {
        status: 200,
        headers: { "content-length": "30000000" },
      }),
  );
  const content = await gdrive.extract({ ...context, item });
  const file = (content as ConnectorExtractedFile).file;
  await assert.rejects(
    file.download({ maxBytes: 20971520 }),
    (error: unknown) =>
      error instanceof ConnectorItemSkipError && error.reason === "too_large",
  );
});

test("returns picker config without secrets", async () => {
  const gdrive = adapter(async () => {
    throw new Error("No provider request is expected");
  });
  const result = await gdrive.executeAction({
    ...context,
    actionType: "google_drive.picker.config",
    request: {},
    idempotencyKey: "picker",
  });
  assert.equal(result.result.appId, "123456789");
  assert.equal(result.result.developerKey, "picker-key");
  assert.equal(Array.isArray(result.result.mimeTypes), true);
  assert.equal((result.result.mimeTypes as string[]).length > 0, true);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("client-secret"), false);
  assert.equal(serialized.includes("access-token"), false);
});

test("never puts the access token in an error message", async () => {
  const gdrive = adapter(async () => json({ error: { code: 500 } }, 500));
  let captured: unknown;
  try {
    const input: ConnectorDiscoverInput = {
      ...context,
      config: { fileIds: ["filesecret01"] },
      accessToken: "tok-secret",
      cursor: null,
    };
    for await (const _page of gdrive.discoverPages!(input)) {
      // Drain the iterator so the failing request runs.
    }
  } catch (error) {
    captured = error;
  }
  assert.ok(captured instanceof Error);
  assert.equal(captured.message.includes("tok-secret"), false);
});
