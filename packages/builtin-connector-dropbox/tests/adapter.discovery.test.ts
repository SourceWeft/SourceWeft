import assert from "node:assert/strict";
import test from "node:test";
import type { ConnectorDiscoveryPage, ConnectorItem } from "@sourceweft/contracts";
import {
  createDropboxConnectorAdapter,
  parseDropboxSelection,
} from "../src/adapter";
import { DropboxAdapterError } from "../src/dropbox-client";

type FetchCall = { url: string; init: RequestInit; body: unknown };

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Routes a fake fetcher by Dropbox RPC/content endpoint, recording every
 * call (with its parsed JSON body) so tests can assert on headers and
 * request shape. Unrouted endpoints throw, so a stray call fails loudly. */
function router(handlers: {
  account?: (call: FetchCall) => Response | Promise<Response>;
  getMetadata?: (call: FetchCall) => Response | Promise<Response>;
  listFolder?: (call: FetchCall) => Response | Promise<Response>;
  listFolderContinue?: (call: FetchCall) => Response | Promise<Response>;
}) {
  const calls: FetchCall[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const value = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const call: FetchCall = { url: value, init: init ?? {}, body };
    calls.push(call);
    if (value.endsWith("/2/users/get_current_account")) {
      return (handlers.account ?? (() => json({ account_id: "dbid:acc" })))(call);
    }
    if (value.endsWith("/2/files/list_folder/continue")) {
      if (!handlers.listFolderContinue) throw new Error("Unexpected list_folder/continue call");
      return handlers.listFolderContinue(call);
    }
    if (value.endsWith("/2/files/list_folder")) {
      if (!handlers.listFolder) throw new Error("Unexpected list_folder call");
      return handlers.listFolder(call);
    }
    if (value.endsWith("/2/files/get_metadata")) {
      if (!handlers.getMetadata) throw new Error("Unexpected get_metadata call");
      return handlers.getMetadata(call);
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

const context = {
  teamId: "team",
  workspaceId: "workspace",
  connectorId: "connector",
  connectorType: "dropbox",
  config: { items: [] as unknown[] },
  accessToken: "access-token",
  cursor: null,
};

function fileEntry(overrides: Record<string, unknown> = {}) {
  return {
    ".tag": "file",
    id: "id:defaultfile01",
    name: "Report.pdf",
    path_display: "/Report.pdf",
    path_lower: "/report.pdf",
    size: 100,
    server_modified: "2026-01-01T00:00:00Z",
    content_hash: "hash1",
    rev: "rev1",
    is_downloadable: true,
    ...overrides,
  };
}

async function collectPages(
  iterable: AsyncIterable<ConnectorDiscoveryPage>,
): Promise<ConnectorDiscoveryPage[]> {
  const pages: ConnectorDiscoveryPage[] = [];
  for await (const page of iterable) pages.push(page);
  return pages;
}

async function collectItems(
  iterable: AsyncIterable<ConnectorDiscoveryPage>,
): Promise<ConnectorItem[]> {
  const items: ConnectorItem[] = [];
  for await (const page of iterable) items.push(...page.items);
  return items;
}

test("manifest client_id is empty without both credentials", () => {
  const bothCredentials = adapter(async () => json({}));
  const withSecret = createDropboxConnectorAdapter({
    baseUrl: "https://sourceweft.example",
    clientId: "app-key",
    clientSecret: "app-secret",
    fetcher: async () => json({}),
  });
  assert.equal(
    bothCredentials.getManifest().auth.authorizationParams?.client_id,
    "app-key",
  );
  const missingSecret = createDropboxConnectorAdapter({
    baseUrl: "https://sourceweft.example",
    clientId: "app-key",
    clientSecret: "",
    fetcher: async () => json({}),
  });
  assert.equal(missingSecret.getManifest().auth.authorizationParams?.client_id, "");
  const missingClientId = createDropboxConnectorAdapter({
    baseUrl: "https://sourceweft.example",
    clientId: "",
    clientSecret: "app-secret",
    fetcher: async () => json({}),
  });
  assert.equal(missingClientId.getManifest().auth.authorizationParams?.client_id, "");
  assert.equal(withSecret.getManifest().auth.authorizationParams?.client_id, "app-key");
});

test("duplicate ids are rejected", () => {
  assert.throws(
    () =>
      parseDropboxSelection({
        items: [
          { id: "id:samefile001", kind: "file" },
          { id: "id:samefile001", kind: "folder" },
        ],
      }),
    (error: unknown) =>
      error instanceof DropboxAdapterError &&
      error.statusCode === 400 &&
      error.code === "DROPBOX_INVALID_SELECTION",
  );
});

test("rejects a malformed selection entry before any request", async () => {
  const { fetcher, calls } = router({});
  const dbx = adapter(fetcher);
  await assert.rejects(
    collectPages(
      dbx.discoverPages!({
        ...context,
        config: { items: [{ id: "not-a-valid-id", kind: "file" }] },
      }),
    ),
    (error: unknown) =>
      error instanceof DropboxAdapterError && error.code === "DROPBOX_INVALID_SELECTION",
  );
  assert.equal(calls.length, 0);
});

test("empty selection reconciles to nothing", async () => {
  const { fetcher, calls } = router({});
  const dbx = adapter(fetcher);
  const pages = await collectPages(
    dbx.discoverPages!({ ...context, config: { items: [] } }),
  );
  assert.equal(pages.length, 1);
  assert.deepEqual(pages[0]?.items, []);
  assert.equal(pages[0]?.complete, true);
  assert.equal(pages[0]?.reconcileMissing, true);
  assert.equal(calls.length, 0);
});

test("single file emits spec item fields", async () => {
  const { fetcher } = router({
    account: () => json({ account_id: "dbid:acc" }),
    getMetadata: () => json(fileEntry({ id: "id:singlefile1" })),
  });
  const dbx = adapter(fetcher);
  const items = await collectItems(
    dbx.discoverPages!({
      ...context,
      config: { items: [{ id: "id:singlefile1", kind: "file" }] },
    }),
  );
  assert.equal(items.length, 1);
  const item = items[0]!;
  assert.equal(item.externalId, "file:id:singlefile1");
  assert.equal(item.externalUri, "https://www.dropbox.com/home?preview=Report.pdf");
  assert.equal(item.title, "Report.pdf");
  assert.equal(item.mimeType, "application/pdf");
  assert.equal(item.sizeBytes, 100);
  assert.deepEqual(item.externalUpdatedAt, new Date("2026-01-01T00:00:00Z"));
  assert.equal(item.contentHash, "dropbox:hash1");
  assert.deepEqual(item.metadata, {
    dropboxFileId: "id:singlefile1",
    pathDisplay: "/Report.pdf",
    pathLower: "/report.pdf",
    rev: "rev1",
    handling: { kind: "download", mimeType: "application/pdf" },
    pathRoot: null,
  });
});

test("folder is listed recursively across continue pages", async () => {
  const { fetcher } = router({
    listFolder: () =>
      json({
        entries: [fileEntry({ id: "id:folderchild1", name: "A.pdf", path_display: "/Folder/A.pdf" })],
        cursor: "cursor-1",
        has_more: true,
      }),
    listFolderContinue: () =>
      json({
        entries: [fileEntry({ id: "id:folderchild2", name: "B.pdf", path_display: "/Folder/B.pdf" })],
        cursor: "cursor-2",
        has_more: false,
      }),
  });
  const dbx = adapter(fetcher);
  const items = await collectItems(
    dbx.discoverPages!({
      ...context,
      config: { items: [{ id: "id:folderroot01", kind: "folder" }] },
    }),
  );
  assert.deepEqual(
    items.map((item) => item.externalId).sort(),
    ["file:id:folderchild1", "file:id:folderchild2"],
  );
});

test("unsupported and non-downloadable folder children are dropped", async () => {
  const { fetcher } = router({
    listFolder: () =>
      json({
        entries: [
          fileEntry({ id: "id:keptpdf0001", name: "Keep.pdf", path_display: "/Folder/Keep.pdf" }),
          fileEntry({
            id: "id:droppedimg1",
            name: "Image.png",
            path_display: "/Folder/Image.png",
          }),
          fileEntry({
            id: "id:droppeddoc1",
            name: "Draft.docx",
            path_display: "/Folder/Draft.docx",
            is_downloadable: false,
          }),
        ],
        cursor: "",
        has_more: false,
      }),
  });
  const dbx = adapter(fetcher);
  const items = await collectItems(
    dbx.discoverPages!({
      ...context,
      config: { items: [{ id: "id:folderroot02", kind: "folder" }] },
    }),
  );
  assert.deepEqual(items.map((item) => item.externalId), ["file:id:keptpdf0001"]);
});

test("explicitly selected unsupported file is still emitted", async () => {
  const { fetcher } = router({
    getMetadata: () =>
      json(
        fileEntry({
          id: "id:picked0png1",
          name: "Picture.png",
          path_display: "/Picture.png",
          is_downloadable: true,
        }),
      ),
  });
  const dbx = adapter(fetcher);
  const items = await collectItems(
    dbx.discoverPages!({
      ...context,
      config: { items: [{ id: "id:picked0png1", kind: "file" }] },
    }),
  );
  assert.equal(items.length, 1);
  assert.equal(items[0]?.mimeType, "application/octet-stream");
  assert.deepEqual((items[0]?.metadata as { handling: unknown }).handling, {
    kind: "unsupported",
  });
});

test("overlapping selections count each file once", async () => {
  const sharedFile = fileEntry({
    id: "id:sharedfile1",
    name: "x.pdf",
    path_display: "/a/b/x.pdf",
  });
  const { fetcher } = router({
    getMetadata: () => json(sharedFile),
    listFolder: (call) => {
      const path = (call.body as { path: string }).path;
      if (path === "id:folderaaaaa") {
        return json({ entries: [sharedFile], cursor: "", has_more: false });
      }
      if (path === "id:folderbbbbb") {
        return json({ entries: [sharedFile], cursor: "", has_more: false });
      }
      throw new Error(`Unexpected folder path: ${path}`);
    },
  });
  const dbx = adapter(fetcher);
  const items = await collectItems(
    dbx.discoverPages!({
      ...context,
      config: {
        items: [
          { id: "id:folderaaaaa", kind: "folder" },
          { id: "id:folderbbbbb", kind: "folder" },
          { id: "id:sharedfile1", kind: "file" },
        ],
      },
    }),
  );
  assert.equal(items.length, 1);
  assert.equal(items[0]?.externalId, "file:id:sharedfile1");
});

test("1,001 supported files fails with DROPBOX_SELECTION_TOO_LARGE and yields nothing", async () => {
  const entries = Array.from({ length: 1001 }, (_, i) =>
    fileEntry({
      id: `id:toomany${String(i).padStart(4, "0")}`,
      name: `File${i}.txt`,
      path_display: `/Folder/File${i}.txt`,
    }),
  );
  const { fetcher } = router({
    listFolder: () => json({ entries, cursor: "", has_more: false }),
  });
  const dbx = adapter(fetcher);
  const pages: ConnectorDiscoveryPage[] = [];
  await assert.rejects(
    (async () => {
      for await (const page of dbx.discoverPages!({
        ...context,
        config: { items: [{ id: "id:hugefolder1", kind: "folder" }] },
      })) {
        pages.push(page);
      }
    })(),
    (error: unknown) =>
      error instanceof DropboxAdapterError &&
      error.statusCode === 422 &&
      error.code === "DROPBOX_SELECTION_TOO_LARGE" &&
      error.message.includes("1,001"),
  );
  assert.equal(pages.length, 0);
});

test("missing file and missing folder are omitted and the run still completes", async () => {
  const { fetcher } = router({
    getMetadata: (call) => {
      const path = (call.body as { path: string }).path;
      if (path === "id:missingfile1") {
        return json({ error_summary: "path/not_found/..." }, 409);
      }
      return json(fileEntry({ id: "id:keptfile0001", name: "Keep.pdf", path_display: "/Keep.pdf" }));
    },
    listFolder: () => json({ error_summary: "path/not_found/..." }, 409),
  });
  const dbx = adapter(fetcher);
  const pages = await collectPages(
    dbx.discoverPages!({
      ...context,
      config: {
        items: [
          { id: "id:missingfile1", kind: "file" },
          { id: "id:missingfolder1", kind: "folder" },
          { id: "id:keptfile0001", kind: "file" },
        ],
      },
    }),
  );
  const items = pages.flatMap((page) => page.items);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.externalId, "file:id:keptfile0001");
  assert.equal(pages[pages.length - 1]?.complete, true);
  assert.equal(pages[pages.length - 1]?.reconcileMissing, true);
});

test("a non-not_found 409 from get_metadata names the cause and fails the run", async () => {
  const { fetcher } = router({
    getMetadata: () => json({ error_summary: "restricted_content/..." }, 409),
  });
  const dbx = adapter(fetcher);
  const pages: ConnectorDiscoveryPage[] = [];
  await assert.rejects(
    (async () => {
      for await (const page of dbx.discoverPages!({
        ...context,
        config: { items: [{ id: "id:restrictedfile1", kind: "file" }] },
      })) {
        pages.push(page);
      }
    })(),
    (error: unknown) =>
      error instanceof DropboxAdapterError &&
      error.code === "DROPBOX_REQUEST_FAILED" &&
      error.message ===
        "Dropbox refused to read a selected item (restricted_content). Remove it from the selection or try again later.",
  );
  assert.equal(pages.length, 0);
});

test("a non-not_found/not_folder 409 from list_folder names the cause and fails the run", async () => {
  const { fetcher } = router({
    listFolder: () => json({ error_summary: "locked/..." }, 409),
  });
  const dbx = adapter(fetcher);
  const pages: ConnectorDiscoveryPage[] = [];
  await assert.rejects(
    (async () => {
      for await (const page of dbx.discoverPages!({
        ...context,
        config: { items: [{ id: "id:lockedfolder1", kind: "folder" }] },
      })) {
        pages.push(page);
      }
    })(),
    (error: unknown) =>
      error instanceof DropboxAdapterError &&
      error.code === "DROPBOX_REQUEST_FAILED" &&
      error.message ===
        "Dropbox refused to read a selected item (locked). Remove it from the selection or try again later.",
  );
  assert.equal(pages.length, 0);
});

for (const failure of [
  { label: "401", status: 401, summary: null, code: "DROPBOX_REAUTH_REQUIRED" },
  { label: "429", status: 429, summary: null, code: "DROPBOX_RATE_LIMITED" },
  { label: "503", status: 503, summary: null, code: "DROPBOX_UNAVAILABLE" },
  { label: "reset", status: 409, summary: "reset", code: "DROPBOX_CURSOR_RESET" },
]) {
  test(`a failure on a later listing page yields no complete page (${failure.label})`, async () => {
    const { fetcher } = router({
      listFolder: () =>
        json(
          {
            entries: [
              fileEntry({ id: "id:page1file001", name: "A.pdf", path_display: "/Folder/A.pdf" }),
            ],
            cursor: "cursor-1",
            has_more: true,
          },
        ),
      listFolderContinue: () =>
        failure.summary
          ? json({ error_summary: failure.summary }, failure.status)
          : json({ error: "failed" }, failure.status),
    });
    const dbx = adapter(fetcher);
    const pages: ConnectorDiscoveryPage[] = [];
    await assert.rejects(
      (async () => {
        for await (const page of dbx.discoverPages!({
          ...context,
          config: { items: [{ id: "id:failfolder01", kind: "folder" }] },
        })) {
          pages.push(page);
        }
      })(),
      (error: unknown) => error instanceof DropboxAdapterError && error.code === failure.code,
    );
    assert.equal(pages.length, 0);
  });
}

test("team account sends the path root header on file calls", async () => {
  // Case A: root namespace differs from home namespace -> header present.
  {
    const { fetcher, calls } = router({
      account: () =>
        json({
          account_id: "dbid:team",
          root_info: { root_namespace_id: "2", home_namespace_id: "1" },
        }),
      getMetadata: () => json(fileEntry({ id: "id:teamfile0001" })),
    });
    const dbx = adapter(fetcher);
    await collectItems(
      dbx.discoverPages!({
        ...context,
        config: { items: [{ id: "id:teamfile0001", kind: "file" }] },
      }),
    );
    const metadataCall = calls.find((call) => call.url.endsWith("/2/files/get_metadata"));
    const header = new Headers(metadataCall?.init.headers).get("Dropbox-API-Path-Root");
    assert.equal(header, JSON.stringify({ ".tag": "root", root: "2" }));
  }
  // Case B: root namespace equals home namespace -> header absent.
  {
    const { fetcher, calls } = router({
      account: () =>
        json({
          account_id: "dbid:personal",
          root_info: { root_namespace_id: "1", home_namespace_id: "1" },
        }),
      getMetadata: () => json(fileEntry({ id: "id:personalfil1" })),
    });
    const dbx = adapter(fetcher);
    await collectItems(
      dbx.discoverPages!({
        ...context,
        config: { items: [{ id: "id:personalfil1", kind: "file" }] },
      }),
    );
    const metadataCall = calls.find((call) => call.url.endsWith("/2/files/get_metadata"));
    const header = new Headers(metadataCall?.init.headers).get("Dropbox-API-Path-Root");
    assert.equal(header, null);
  }
});

test("externalUri encodes non-ASCII path segments", async () => {
  const { fetcher } = router({
    getMetadata: () =>
      json(
        fileEntry({
          id: "id:nonasciifl1",
          name: "报告 #1.pdf",
          path_display: "/工作/Q3/报告 #1.pdf",
          path_lower: "/工作/q3/报告 #1.pdf",
        }),
      ),
  });
  const dbx = adapter(fetcher);
  const items = await collectItems(
    dbx.discoverPages!({
      ...context,
      config: { items: [{ id: "id:nonasciifl1", kind: "file" }] },
    }),
  );
  assert.equal(
    items[0]?.externalUri,
    `https://www.dropbox.com/home/${encodeURIComponent("工作")}/${encodeURIComponent("Q3")}?preview=${encodeURIComponent("报告 #1.pdf")}`,
  );
});

test("paper item has null hash and size", async () => {
  const { fetcher } = router({
    getMetadata: () =>
      json(
        fileEntry({
          id: "id:paperdoc001",
          name: "Notes.paper",
          path_display: "/Notes.paper",
          size: 500,
          content_hash: "should-be-ignored",
          is_downloadable: false,
        }),
      ),
  });
  const dbx = adapter(fetcher);
  const items = await collectItems(
    dbx.discoverPages!({
      ...context,
      config: { items: [{ id: "id:paperdoc001", kind: "file" }] },
    }),
  );
  assert.equal(items[0]?.sizeBytes, null);
  assert.equal(items[0]?.contentHash, null);
  assert.equal(items[0]?.mimeType, "text/markdown");
  assert.deepEqual((items[0]?.metadata as { handling: unknown }).handling, {
    kind: "export_paper",
    mimeType: "text/markdown",
  });
});

test("pages are 50 items with offset continuations", async () => {
  const entries = Array.from({ length: 120 }, (_, i) =>
    fileEntry({
      id: `id:page50f${String(i).padStart(4, "0")}`,
      name: `File${i}.txt`,
      path_display: `/Folder/File${i}.txt`,
    }),
  );
  const { fetcher } = router({
    listFolder: () => json({ entries, cursor: "", has_more: false }),
  });
  const dbx = adapter(fetcher);
  const pages = await collectPages(
    dbx.discoverPages!({
      ...context,
      config: { items: [{ id: "id:bigfolder001", kind: "folder" }] },
    }),
  );
  assert.equal(pages.length, 3);
  assert.equal(pages[0]?.items.length, 50);
  assert.equal(pages[1]?.items.length, 50);
  assert.equal(pages[2]?.items.length, 20);
  assert.deepEqual(pages[0]?.continuation, { offset: 50 });
  assert.equal(pages[0]?.complete, false);
  assert.equal(pages[0]?.reconcileMissing, false);
  assert.deepEqual(pages[1]?.continuation, { offset: 100 });
  assert.equal(pages[1]?.complete, false);
  assert.equal(pages[1]?.reconcileMissing, false);
  assert.equal(pages[2]?.continuation, null);
  assert.equal(pages[2]?.complete, true);
  assert.equal(pages[2]?.reconcileMissing, true);
});
