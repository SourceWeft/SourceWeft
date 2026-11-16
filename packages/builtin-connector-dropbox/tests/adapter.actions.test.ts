import assert from "node:assert/strict";
import test from "node:test";
import type { ConnectorActionInput } from "@sourceweft/contracts";
import { createDropboxConnectorAdapter } from "../src/adapter";
import { DropboxAdapterError } from "../src/dropbox-client";

type FetchCall = { url: string; body: unknown };

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Routes a fake fetcher by Dropbox RPC endpoint, recording every call (with
 * its parsed JSON body) so tests can assert on request shape. A handler
 * receiving an array is called once per invocation, in order (useful for
 * get_metadata, which this adapter may call several times per action with
 * different paths). Unrouted endpoints throw. */
function router(handlers: {
  account?: (call: FetchCall) => Response | Promise<Response>;
  getMetadata?: (call: FetchCall) => Response | Promise<Response>;
  listFolder?: (call: FetchCall) => Response | Promise<Response>;
  listFolderContinue?: (call: FetchCall) => Response | Promise<Response>;
  search?: (call: FetchCall) => Response | Promise<Response>;
  searchContinue?: (call: FetchCall) => Response | Promise<Response>;
}) {
  const calls: FetchCall[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const value = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const call: FetchCall = { url: value, body };
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
    if (value.endsWith("/2/files/search/continue_v2")) {
      if (!handlers.searchContinue) throw new Error("Unexpected search/continue_v2 call");
      return handlers.searchContinue(call);
    }
    if (value.endsWith("/2/files/search_v2")) {
      if (!handlers.search) throw new Error("Unexpected search_v2 call");
      return handlers.search(call);
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

function actionInput(
  actionType: string,
  request: Record<string, unknown>,
): ConnectorActionInput {
  return {
    teamId: "team",
    workspaceId: "workspace",
    connectorId: "connector",
    connectorType: "dropbox",
    actionType,
    request,
    config: { items: [] },
    accessToken: "access-token",
    idempotencyKey: "idem-1",
  };
}

function fileEntry(overrides: Record<string, unknown> = {}) {
  return {
    ".tag": "file",
    id: "id:defaultfile01",
    name: "Report.pdf",
    path_display: "/Report.pdf",
    path_lower: "/report.pdf",
    size: 100,
    server_modified: "2026-01-01T00:00:00Z",
    is_downloadable: true,
    ...overrides,
  };
}

function folderEntry(overrides: Record<string, unknown> = {}) {
  return {
    ".tag": "folder",
    id: "id:defaultfold01",
    name: "Folder",
    path_display: "/Folder",
    path_lower: "/folder",
    ...overrides,
  };
}

test("browse root lists sorted entries with supported flags", async () => {
  const { fetcher, calls } = router({
    listFolder: () =>
      json({
        entries: [
          fileEntry({ id: "id:zfile00000001", name: "zebra.pdf", path_display: "/zebra.pdf" }),
          folderEntry({ id: "id:afold00000001", name: "Apples", path_display: "/Apples" }),
          fileEntry({
            id: "id:bfile00000001",
            name: "banana.png",
            path_display: "/banana.png",
            is_downloadable: true,
          }),
        ],
        cursor: "cursor-1",
        has_more: false,
      }),
  });
  const dbx = adapter(fetcher);
  const result = await dbx.executeAction(actionInput("dropbox.browse", {}));
  assert.deepEqual(result.result, {
    folder: null,
    breadcrumbs: [],
    entries: [
      {
        id: "id:afold00000001",
        kind: "folder",
        name: "Apples",
        pathDisplay: "/Apples",
        size: null,
        serverModified: null,
        supported: true,
      },
      {
        id: "id:bfile00000001",
        kind: "file",
        name: "banana.png",
        pathDisplay: "/banana.png",
        size: 100,
        serverModified: "2026-01-01T00:00:00Z",
        supported: false,
      },
      {
        id: "id:zfile00000001",
        kind: "file",
        name: "zebra.pdf",
        pathDisplay: "/zebra.pdf",
        size: 100,
        serverModified: "2026-01-01T00:00:00Z",
        supported: true,
      },
    ],
    cursor: "cursor-1",
    hasMore: false,
  });
  const listFolderCall = calls.find((call) => call.url.endsWith("/2/files/list_folder"));
  assert.equal((listFolderCall?.body as { path: string }).path, "");
  assert.equal((listFolderCall?.body as { limit: number }).limit, 200);
  assert.equal((listFolderCall?.body as { recursive: boolean }).recursive, false);
});

test("browse folder builds breadcrumbs from path_display", async () => {
  const { fetcher } = router({
    listFolder: () => json({ entries: [], cursor: "", has_more: false }),
    getMetadata: (call) => {
      const path = (call.body as { path: string }).path;
      if (path === "id:folderccccc1") {
        return json(folderEntry({ id: "id:folderccccc1", name: "C", path_display: "/A/B/C" }));
      }
      if (path === "/A") {
        return json(folderEntry({ id: "id:folderaaaaa1", name: "A", path_display: "/A" }));
      }
      if (path === "/A/B") {
        return json(folderEntry({ id: "id:folderbbbbb1", name: "B", path_display: "/A/B" }));
      }
      throw new Error(`Unexpected get_metadata path: ${path}`);
    },
  });
  const dbx = adapter(fetcher);
  const result = await dbx.executeAction(
    actionInput("dropbox.browse", { folderId: "id:folderccccc1" }),
  );
  assert.deepEqual(result.result.folder, {
    id: "id:folderccccc1",
    name: "C",
    pathDisplay: "/A/B/C",
  });
  assert.deepEqual(result.result.breadcrumbs, [
    { id: "id:folderaaaaa1", name: "A" },
    { id: "id:folderbbbbb1", name: "B" },
  ]);
});

test("browse omits a breadcrumb whose ancestor metadata is missing", async () => {
  const { fetcher } = router({
    listFolder: () => json({ entries: [], cursor: "", has_more: false }),
    getMetadata: (call) => {
      const path = (call.body as { path: string }).path;
      if (path === "id:foldercccc02") {
        return json(folderEntry({ id: "id:foldercccc02", name: "C", path_display: "/A/B/C" }));
      }
      if (path === "/A") {
        return json({ error_summary: "path/not_found/.." }, 409);
      }
      if (path === "/A/B") {
        return json(folderEntry({ id: "id:folderbbbb02", name: "B", path_display: "/A/B" }));
      }
      throw new Error(`Unexpected get_metadata path: ${path}`);
    },
  });
  const dbx = adapter(fetcher);
  const result = await dbx.executeAction(
    actionInput("dropbox.browse", { folderId: "id:foldercccc02" }),
  );
  assert.deepEqual(result.result.breadcrumbs, [{ id: "id:folderbbbb02", name: "B" }]);
});

test("browse with cursor continues without folder", async () => {
  const { fetcher, calls } = router({
    listFolderContinue: () =>
      json({
        entries: [fileEntry({ id: "id:pagedfile001", name: "A.pdf", path_display: "/A.pdf" })],
        cursor: "cursor-2",
        has_more: true,
      }),
  });
  const dbx = adapter(fetcher);
  const result = await dbx.executeAction(
    actionInput("dropbox.browse", { cursor: "cursor-1" }),
  );
  assert.equal(result.result.folder, null);
  assert.deepEqual(result.result.breadcrumbs, []);
  assert.equal((result.result.entries as unknown[]).length, 1);
  assert.equal(result.result.cursor, "cursor-2");
  assert.equal(result.result.hasMore, true);
  assert.equal(calls.some((call) => call.url.endsWith("/2/files/list_folder")), false);
});

test("search returns entries and cursor", async () => {
  const { fetcher, calls } = router({
    search: (call) =>
      json({
        matches: [
          {
            metadata: {
              metadata: fileEntry({
                id: "id:searchhit001",
                name: "Annual Report.pdf",
                path_display: "/Annual Report.pdf",
              }),
            },
          },
        ],
        cursor: "search-cursor-1",
        has_more: false,
      }),
  });
  const dbx = adapter(fetcher);
  const result = await dbx.executeAction(
    actionInput("dropbox.search", { query: "  annual report  " }),
  );
  assert.deepEqual(result.result, {
    entries: [
      {
        id: "id:searchhit001",
        kind: "file",
        name: "Annual Report.pdf",
        pathDisplay: "/Annual Report.pdf",
        size: 100,
        serverModified: "2026-01-01T00:00:00Z",
        supported: true,
      },
    ],
    cursor: "search-cursor-1",
    hasMore: false,
  });
  const searchCall = calls.find((call) => call.url.endsWith("/2/files/search_v2"));
  assert.deepEqual(searchCall?.body, {
    query: "annual report",
    options: {
      filename_only: true,
      file_status: "active",
      max_results: 50,
    },
  });
});

test("search continues with a cursor", async () => {
  const { fetcher, calls } = router({
    searchContinue: () =>
      json({
        matches: [
          { metadata: { metadata: fileEntry({ id: "id:searchhit002", name: "B.pdf" }) } },
        ],
        cursor: "search-cursor-2",
        has_more: false,
      }),
  });
  const dbx = adapter(fetcher);
  const result = await dbx.executeAction(
    actionInput("dropbox.search", { query: "report", cursor: "search-cursor-1" }),
  );
  assert.equal((result.result.entries as unknown[]).length, 1);
  assert.equal(calls.some((call) => call.url.endsWith("/2/files/search_v2")), false);
});

test("blank query is rejected without a request", async () => {
  const { fetcher, calls } = router({});
  const dbx = adapter(fetcher);
  await assert.rejects(
    dbx.executeAction(actionInput("dropbox.search", { query: "   " })),
    (error: unknown) =>
      error instanceof DropboxAdapterError && error.code === "DROPBOX_INVALID_REQUEST",
  );
  assert.equal(calls.length, 0);
});

test("describe marks missing ids exists:false", async () => {
  const { fetcher } = router({
    getMetadata: (call) => {
      const path = (call.body as { path: string }).path;
      if (path === "id:missingone01") {
        return json({ error_summary: "path/not_found/.." }, 409);
      }
      return json(fileEntry({ id: "id:existsfile01", name: "Keep.pdf", path_display: "/Keep.pdf" }));
    },
  });
  const dbx = adapter(fetcher);
  const result = await dbx.executeAction(
    actionInput("dropbox.describe", { ids: ["id:missingone01", "id:existsfile01"] }),
  );
  assert.deepEqual(result.result.items, [
    {
      id: "id:missingone01",
      kind: null,
      name: null,
      pathDisplay: null,
      pathLower: null,
      exists: false,
    },
    {
      id: "id:existsfile01",
      kind: "file",
      name: "Keep.pdf",
      pathDisplay: "/Keep.pdf",
      pathLower: "/report.pdf",
      exists: true,
    },
  ]);
});

test("describe caps concurrent getMetadata calls at 8", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const { fetcher } = router({
    getMetadata: async (call) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Hold every call open long enough for every available worker to
      // start before any of them resolves, so a concurrency cap above 8
      // would show up as more than 8 simultaneously in flight.
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight--;
      const path = (call.body as { path: string }).path;
      return json(fileEntry({ id: path, name: "Keep.pdf", path_display: "/Keep.pdf" }));
    },
  });
  const dbx = adapter(fetcher);
  const ids = Array.from({ length: 24 }, (_, i) => `id:concur${String(i).padStart(4, "0")}`);
  await dbx.executeAction(actionInput("dropbox.describe", { ids }));
  assert.equal(maxInFlight, 8);
});

test("describe rejects 101 ids", async () => {
  const { fetcher, calls } = router({});
  const dbx = adapter(fetcher);
  const ids = Array.from({ length: 101 }, (_, i) => `id:toomanyid${String(i).padStart(3, "0")}`);
  await assert.rejects(
    dbx.executeAction(actionInput("dropbox.describe", { ids })),
    (error: unknown) =>
      error instanceof DropboxAdapterError && error.code === "DROPBOX_INVALID_REQUEST",
  );
  assert.equal(calls.length, 0);
});

test("action 401 surfaces DROPBOX_REAUTH_REQUIRED", async () => {
  const { fetcher } = router({
    account: () => json({ error_summary: "invalid_access_token/.." }, 401),
  });
  const dbx = adapter(fetcher);
  await assert.rejects(
    dbx.executeAction(actionInput("dropbox.browse", {})),
    (error: unknown) =>
      error instanceof DropboxAdapterError &&
      error.statusCode === 401 &&
      error.code === "DROPBOX_REAUTH_REQUIRED",
  );
});

test("unknown action is rejected", async () => {
  const { fetcher, calls } = router({});
  const dbx = adapter(fetcher);
  await assert.rejects(
    dbx.executeAction(actionInput("dropbox.nope", {})),
    (error: unknown) =>
      error instanceof DropboxAdapterError && error.code === "DROPBOX_UNSUPPORTED_ACTION",
  );
  assert.equal(calls.length, 0);
});
