import assert from "node:assert/strict";
import { afterAll, beforeAll, beforeEach, test, vi } from "vitest";
import { createDropboxConnectorAdapter } from "@sourceweft/builtin-connector-dropbox";
import { createIsolatedTestDatabase } from "../../test/isolated-database";
import { makeSetup } from "./sync-test-support";

let schema: typeof import("@sourceweft/db");
let connectorRuntime: typeof import("./index");
let syncRunRepo: typeof import("./repository/sync-run");
let indexing: typeof import("../sources/indexing-service");
let setup: ReturnType<typeof makeSetup>;
let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
const originalUrl = process.env.DATABASE_URL;

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("dropbox_sync");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
  connectorRuntime = await import("./index");
  syncRunRepo = await import("./repository/sync-run");
  indexing = await import("../sources/indexing-service");
  setup = makeSetup({ schema, connectorRuntime, syncRunRepo, indexing });
}, 120_000);

afterAll(async () => {
  vi.restoreAllMocks();
  if (schema) await schema.database.end();
  if (isolated) await isolated.close();
  if (originalUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalUrl;
});

beforeEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// A tiny mutable in-memory Dropbox tree, served by a fake fetcher that routes
// on the real Dropbox RPC/content endpoints the client hits
// (`get_current_account`, `get_metadata`, `list_folder`, `files/download`).
// Mirrors the `router` pattern used by the package's own
// `tests/adapter.discovery.test.ts` / `adapter.extract.test.ts`.
// ---------------------------------------------------------------------------

type FakeEntry = {
  id: string;
  tag: "file" | "folder";
  name: string;
  path: string;
  parentId: string | null;
  body?: string;
};

class FakeDropboxTree {
  private readonly entries = new Map<string, FakeEntry>();

  add(entry: FakeEntry): void {
    this.entries.set(entry.id, entry);
  }

  remove(id: string): void {
    this.entries.delete(id);
  }

  get(id: string): FakeEntry | undefined {
    return this.entries.get(id);
  }

  /** Direct children only — sufficient for this test's one-level folder. */
  childrenOf(folderId: string): FakeEntry[] {
    return [...this.entries.values()].filter(
      (entry) => entry.parentId === folderId,
    );
  }
}

function toDropboxJson(entry: FakeEntry): Record<string, unknown> {
  return {
    ".tag": entry.tag,
    id: entry.id,
    name: entry.name,
    path_display: entry.path,
    path_lower: entry.path.toLowerCase(),
    ...(entry.tag === "file"
      ? {
          size: entry.body ? Buffer.byteLength(entry.body) : 0,
          server_modified: "2026-11-01T00:00:00Z",
          content_hash: `hash:${entry.id}`,
          rev: "rev1",
          is_downloadable: true,
        }
      : {}),
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function notFound(): Response {
  return json({ error_summary: "path/not_found/..." }, 409);
}

function createFakeDropboxFetcher(tree: FakeDropboxTree): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const value = String(url);
    if (value.endsWith("/2/users/get_current_account")) {
      return json({ account_id: "dbid:acc" });
    }
    if (value.endsWith("/2/files/get_metadata")) {
      const body = JSON.parse(String(init?.body)) as { path: string };
      const entry = tree.get(body.path);
      if (!entry) return notFound();
      return json(toDropboxJson(entry));
    }
    if (value.endsWith("/2/files/list_folder")) {
      const body = JSON.parse(String(init?.body)) as { path: string };
      const folder = tree.get(body.path);
      if (!folder || folder.tag !== "folder") return notFound();
      const children = tree
        .childrenOf(folder.id)
        .filter((entry) => entry.tag === "file");
      return json({
        entries: children.map(toDropboxJson),
        cursor: "",
        has_more: false,
      });
    }
    if (value.endsWith("/2/files/download")) {
      const headers = new Headers(init?.headers);
      const apiArg = JSON.parse(headers.get("Dropbox-API-Arg") ?? "{}") as {
        path: string;
      };
      const entry = tree.get(apiArg.path);
      if (!entry || entry.body === undefined) return notFound();
      return new Response(entry.body, { status: 200 });
    }
    throw new Error(`Unexpected Dropbox request: ${value}`);
  }) as typeof fetch;
}

function dropboxAdapter(tree: FakeDropboxTree) {
  return createDropboxConnectorAdapter({
    baseUrl: "https://sourceweft.example",
    clientId: "app-key",
    clientSecret: "app-secret",
    fetcher: createFakeDropboxFetcher(tree),
  });
}

test("selected file and folder index, then a deletion is archived", async () => {
  const tree = new FakeDropboxTree();
  tree.add({
    id: "id:notes1",
    tag: "file",
    name: "notes.txt",
    path: "/notes.txt",
    parentId: null,
    body: "root note body",
  });
  tree.add({
    id: "id:proj",
    tag: "folder",
    name: "proj",
    path: "/proj",
    parentId: null,
  });
  tree.add({
    id: "id:a1",
    tag: "file",
    name: "a.md",
    path: "/proj/a.md",
    parentId: "id:proj",
    body: "# A",
  });
  tree.add({
    id: "id:b1",
    tag: "file",
    name: "b.txt",
    path: "/proj/b.txt",
    parentId: "id:proj",
    body: "b body",
  });
  tree.add({
    id: "id:pic1",
    tag: "file",
    name: "pic.png",
    path: "/proj/pic.png",
    parentId: "id:proj",
    body: "binary-ish",
  });

  const t = await setup({
    pagesOf: [],
    adapter: dropboxAdapter(tree),
    connectorType: "dropbox",
    configJson: {
      items: [
        { id: "id:notes1", kind: "file" },
        { id: "id:proj", kind: "folder" },
      ],
    },
  });

  // First sync: three supported files are discovered and indexed; the
  // unsupported pic.png is dropped silently inside the selected folder and
  // never becomes a source.
  const run1 = await t.sync();
  assert.equal(run1.status, "succeeded");
  const rows1 = await t.sourceRows();
  assert.deepEqual(
    rows1.map((row) => row.externalId).sort(),
    ["file:id:a1", "file:id:b1", "file:id:notes1"],
  );
  assert.equal(
    rows1.every((row) => row.status === "indexed"),
    true,
  );

  // Second sync: b.txt is deleted from the fake tree. The reconciling scan
  // archives its source; the other two stay indexed.
  tree.remove("id:b1");
  const run2 = await t.sync();
  assert.equal(run2.status, "succeeded");
  const rows2 = await t.sourceRows();
  const statusByExternalId = Object.fromEntries(
    rows2.map((row) => [row.externalId, row.status]),
  );
  assert.equal(statusByExternalId["file:id:b1"], "archived");
  assert.equal(statusByExternalId["file:id:a1"], "indexed");
  assert.equal(statusByExternalId["file:id:notes1"], "indexed");

  // Third sync: the folder now holds 1,001 files, past the selection cap.
  // The run fails before any page is produced, and no source changes status.
  for (let i = 0; i < 1001; i += 1) {
    tree.add({
      id: `id:big${String(i).padStart(4, "0")}`,
      tag: "file",
      name: `big${i}.txt`,
      path: `/proj/big${i}.txt`,
      parentId: "id:proj",
      body: "x",
    });
  }
  const rowsBeforeCapFailure = await t.sourceRows();
  const run3 = await t.sync();
  assert.equal(run3.status, "failed");
  assert.equal(run3.errorCode, "DROPBOX_SELECTION_TOO_LARGE");
  const rowsAfterCapFailure = await t.sourceRows();
  assert.deepEqual(
    rowsAfterCapFailure.map((row) => ({ id: row.id, status: row.status })),
    rowsBeforeCapFailure.map((row) => ({ id: row.id, status: row.status })),
  );
});
