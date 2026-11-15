import { describe, expect, test, vi } from "vitest";
import { connectorItemSkipReasons } from "@sourceweft/contracts";
import {
  commitDropboxSelection,
  DROPBOX_MAX_FILES,
  DROPBOX_MAX_SELECTED_ITEMS,
  dropboxErrorKey,
  dropboxExternalId,
  dropboxFolderFileCount,
  dropboxItemState,
  dropboxSkipReasonKey,
  mergeDropboxSelection,
  readDropboxSelection,
  removeDropboxItem,
  toggleDropboxSelection,
} from "./dropbox-selection";

describe("DROPBOX_MAX_SELECTED_ITEMS and DROPBOX_MAX_FILES", () => {
  test("are 500 and 1000", () => {
    expect(DROPBOX_MAX_SELECTED_ITEMS).toBe(500);
    expect(DROPBOX_MAX_FILES).toBe(1000);
  });
});

describe("dropboxExternalId", () => {
  test("prefixes the id with file:", () => {
    expect(dropboxExternalId("id:abc")).toBe("file:id:abc");
  });
});

describe("readDropboxSelection", () => {
  test("drops entries with bad kind or id", () => {
    expect(
      readDropboxSelection({
        items: [
          { id: "id:abc", kind: "file" },
          { id: "id:def", kind: "folder" },
          { id: "id:bad kind", kind: "sheet" },
          { id: "not-an-id", kind: "file" },
          { id: 123, kind: "file" },
          "junk",
          null,
          { kind: "file" },
          { id: "id:abc" },
        ],
      }),
    ).toEqual([
      { id: "id:abc", kind: "file" },
      { id: "id:def", kind: "folder" },
    ]);
  });

  test("returns an empty array when items is missing or not an array", () => {
    expect(readDropboxSelection({})).toEqual([]);
    expect(readDropboxSelection({ items: "nope" })).toEqual([]);
  });
});

describe("toggleDropboxSelection", () => {
  test("adds then removes", () => {
    const added = toggleDropboxSelection([], { id: "id:a", kind: "file" });
    expect(added).toEqual([{ id: "id:a", kind: "file" }]);

    const removed = toggleDropboxSelection(added, {
      id: "id:a",
      kind: "file",
    });
    expect(removed).toEqual([]);
  });

  test("adding one item leaves other existing items untouched", () => {
    const current = [
      { id: "id:a", kind: "file" as const },
      { id: "id:b", kind: "folder" as const },
    ];
    expect(
      toggleDropboxSelection(current, { id: "id:c", kind: "file" }),
    ).toEqual([...current, { id: "id:c", kind: "file" }]);
  });
});

describe("mergeDropboxSelection", () => {
  test("appends new picks and drops duplicates by id", () => {
    const current = [{ id: "id:a", kind: "file" as const }];
    const picked = [
      { id: "id:a", kind: "file" as const },
      { id: "id:b", kind: "folder" as const },
    ];
    expect(mergeDropboxSelection(current, picked)).toEqual({
      ok: true,
      items: [
        { id: "id:a", kind: "file" },
        { id: "id:b", kind: "folder" },
      ],
      added: 1,
    });
  });

  test("rejects whole selection past 500", () => {
    const current = Array.from({ length: 499 }, (_, i) => ({
      id: `id:f${i}`,
      kind: "file" as const,
    }));
    const picked = [
      { id: "id:x", kind: "file" as const },
      { id: "id:y", kind: "file" as const },
    ];
    expect(mergeDropboxSelection(current, picked)).toEqual({
      ok: false,
      reason: "limit",
      limit: 500,
      attempted: 501,
    });
  });

  test("allows exactly 500", () => {
    const current = Array.from({ length: 499 }, (_, i) => ({
      id: `id:f${i}`,
      kind: "file" as const,
    }));
    const result = mergeDropboxSelection(current, [
      { id: "id:x", kind: "file" as const },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.items).toHaveLength(500);
    }
  });
});

describe("removeDropboxItem", () => {
  test("removes one item by id, preserving order of the rest", () => {
    const current = [
      { id: "id:a", kind: "file" as const },
      { id: "id:b", kind: "folder" as const },
    ];
    expect(removeDropboxItem(current, "id:a")).toEqual([
      { id: "id:b", kind: "folder" },
    ]);
  });

  test("removing the last item leaves an empty selection", () => {
    expect(
      removeDropboxItem([{ id: "id:a", kind: "file" as const }], "id:a"),
    ).toEqual([]);
  });
});

describe("dropboxFolderFileCount", () => {
  test("folder counts match whole path segments only", () => {
    const sources = [
      { status: "indexed", metadata: { pathLower: "/a/b/x.pdf" } },
      { status: "indexed", metadata: { pathLower: "/a/b/c/y.pdf" } },
      { status: "indexed", metadata: { pathLower: "/a/bc/z.pdf" } },
      { status: "indexed", metadata: { pathLower: "/a/b" } },
    ];
    expect(dropboxFolderFileCount({ folderPathLower: "/a/b", sources })).toBe(
      2,
    );
  });

  test("counts only indexed sources", () => {
    const sources = [
      { status: "indexed", metadata: { pathLower: "/a/b/x.pdf" } },
      { status: "processing", metadata: { pathLower: "/a/b/y.pdf" } },
      { status: "failed", metadata: { pathLower: "/a/b/z.pdf" } },
      { status: "pending", metadata: { pathLower: "/a/b/w.pdf" } },
    ];
    expect(dropboxFolderFileCount({ folderPathLower: "/a/b", sources })).toBe(
      1,
    );
  });

  test("is defensive about archived sources even though listSources already excludes them", () => {
    const sources = [
      { status: "archived", metadata: { pathLower: "/a/b/x.pdf" } },
      { status: "indexed", metadata: { pathLower: "/a/b/y.pdf" } },
    ];
    expect(dropboxFolderFileCount({ folderPathLower: "/a/b", sources })).toBe(
      1,
    );
  });

  test("ignores sources with a missing or non-string pathLower", () => {
    const sources = [
      { status: "indexed", metadata: {} },
      { status: "indexed", metadata: { pathLower: 42 } },
    ];
    expect(dropboxFolderFileCount({ folderPathLower: "/a/b", sources })).toBe(
      0,
    );
  });
});

describe("dropboxSkipReasonKey", () => {
  test("maps every skip reason to a message key and unknown ones to a fallback", () => {
    const keys = connectorItemSkipReasons.map((reason) =>
      dropboxSkipReasonKey(reason),
    );
    expect(connectorItemSkipReasons).toContain("unreadable");
    expect(new Set(keys).size).toBe(connectorItemSkipReasons.length);
    expect(dropboxSkipReasonKey("weird")).toMatch(/\.unknown$/);
    expect(dropboxSkipReasonKey("too_large")).toBe(
      "connectors.dropbox.skipReason.too_large",
    );
  });
});

describe("dropboxErrorKey", () => {
  test("maps reconnect, notFound, tryLater, generic", () => {
    expect(dropboxErrorKey("CONNECTOR_OAUTH_ACCOUNT_UNAVAILABLE")).toBe(
      "connectors.dropbox.error.reconnect",
    );
    expect(dropboxErrorKey("CONNECTOR_REAUTH_REQUIRED")).toBe(
      "connectors.dropbox.error.reconnect",
    );
    expect(dropboxErrorKey("DROPBOX_REAUTH_REQUIRED")).toBe(
      "connectors.dropbox.error.reconnect",
    );
    expect(dropboxErrorKey("DROPBOX_CONNECTOR_NOT_FOUND")).toBe(
      "connectors.dropbox.error.notFound",
    );
    expect(dropboxErrorKey("DROPBOX_RATE_LIMITED")).toBe(
      "connectors.dropbox.error.tryLater",
    );
    expect(dropboxErrorKey("DROPBOX_UNAVAILABLE")).toBe(
      "connectors.dropbox.error.tryLater",
    );
    expect(dropboxErrorKey("DROPBOX_CURSOR_RESET")).toBe(
      "connectors.dropbox.error.tryLater",
    );
    expect(dropboxErrorKey(undefined)).toBe("connectors.dropbox.error.generic");
    expect(dropboxErrorKey("SOMETHING_ELSE")).toBe(
      "connectors.dropbox.error.generic",
    );
  });
});

describe("dropboxItemState", () => {
  // Port of the four core cases from google-drive-selection.test.ts, since
  // dropboxItemState shares its logic with googleDriveFileState via
  // connector-file-state.ts.
  const externalId = dropboxExternalId("id:abc");
  const runStart = new Date("2026-11-13T10:00:00.000Z");
  const beforeRun = new Date("2026-11-13T09:00:00.000Z");
  const afterRun = new Date("2026-11-13T11:00:00.000Z");

  function succeededRun(
    skippedItems: Array<{ externalId: string; reason: string }> = [],
  ) {
    return { status: "succeeded", startedAt: runStart, skippedItems };
  }

  test("reports a skipped file with its reason, even over a stale indexed source", () => {
    expect(
      dropboxItemState({
        fileId: "id:abc",
        source: { status: "indexed" },
        latestRun: succeededRun([{ externalId, reason: "needs_ocr" }]),
        selectionChangedAt: null,
      }),
    ).toEqual({ kind: "skipped", reason: "needs_ocr" });
  });

  test("maps an active source's status to indexed, processing, or failed", () => {
    expect(
      dropboxItemState({
        fileId: "id:abc",
        source: { status: "indexed" },
        latestRun: succeededRun(),
        selectionChangedAt: null,
      }).kind,
    ).toBe("indexed");
    expect(
      dropboxItemState({
        fileId: "id:abc",
        source: { status: "failed" },
        latestRun: succeededRun(),
        selectionChangedAt: null,
      }).kind,
    ).toBe("failed");
    expect(
      dropboxItemState({
        fileId: "id:abc",
        source: { status: "processing" },
        latestRun: succeededRun(),
        selectionChangedAt: null,
      }).kind,
    ).toBe("processing");
  });

  test("shows unavailable once a run that started after the change has succeeded", () => {
    expect(
      dropboxItemState({
        fileId: "id:abc",
        source: null,
        latestRun: {
          status: "succeeded",
          startedAt: afterRun,
          skippedItems: [],
        },
        selectionChangedAt: runStart,
      }).kind,
    ).toBe("unavailable");
  });

  test("shows waiting, not unavailable, for a file added after the latest successful run started", () => {
    expect(
      dropboxItemState({
        fileId: "id:abc",
        source: null,
        latestRun: {
          status: "succeeded",
          startedAt: beforeRun,
          skippedItems: [],
        },
        selectionChangedAt: runStart,
      }).kind,
    ).toBe("waiting");
  });
});

describe("commitDropboxSelection", () => {
  test("does not sync when the save fails", async () => {
    const sync = vi.fn();
    const result = await commitDropboxSelection({
      save: async () => false,
      sync,
    });
    expect(result).toBe(false);
    expect(sync).not.toHaveBeenCalled();
  });

  test("syncs after a successful save", async () => {
    const sync = vi.fn();
    const result = await commitDropboxSelection({
      save: async () => true,
      sync,
    });
    expect(result).toBe(true);
    expect(sync).toHaveBeenCalledTimes(1);
  });
});
