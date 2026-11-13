import { describe, expect, test, vi } from "vitest";
import { connectorItemSkipReasons } from "@sourceweft/contracts";
import {
  commitGoogleDriveSelection,
  GOOGLE_DRIVE_MAX_FILES,
  googleDriveExternalId,
  googleDriveFileName,
  googleDriveFileState,
  googleDrivePickerErrorKey,
  googleDriveSkipReasonKey,
  mergeGoogleDriveSelection,
  parseGoogleDriveFileIds,
  removeGoogleDriveFile,
} from "./google-drive-selection";

test("reads file ids from config and ignores junk", () => {
  expect(parseGoogleDriveFileIds({ fileIds: ["a", 1, null, "b"] })).toEqual([
    "a",
    "b",
  ]);
  expect(parseGoogleDriveFileIds({})).toEqual([]);
});

test("appends new picks and drops duplicates", () => {
  expect(mergeGoogleDriveSelection(["a", "b"], ["b", "c", "c"])).toEqual({
    ok: true,
    fileIds: ["a", "b", "c"],
    added: 1,
  });
});

test("picking only already-selected files adds nothing", () => {
  const result = mergeGoogleDriveSelection(["a", "b"], ["a", "b"]);
  expect(result).toEqual({ ok: true, fileIds: ["a", "b"], added: 0 });
});

test("refuses to exceed 500 without truncating", () => {
  const current = Array.from({ length: 499 }, (_, i) => `f${i}`);
  expect(mergeGoogleDriveSelection(current, ["x", "y"])).toEqual({
    ok: false,
    reason: "limit",
    limit: 500,
    attempted: 501,
  });
});

test("allows exactly 500", () => {
  const current = Array.from({ length: 499 }, (_, i) => `f${i}`);
  const result = mergeGoogleDriveSelection(current, ["x"]);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.fileIds).toHaveLength(500);
  }
});

test("removes one file", () => {
  expect(removeGoogleDriveFile(["a", "b"], "a")).toEqual(["b"]);
});

test("removing the last file leaves an empty selection", () => {
  expect(removeGoogleDriveFile(["a"], "a")).toEqual([]);
});

test("maps every skip reason to a message key and unknown ones to a fallback", () => {
  const keys = connectorItemSkipReasons.map((reason) =>
    googleDriveSkipReasonKey(reason),
  );
  expect(connectorItemSkipReasons).toContain("unreadable");
  expect(new Set(keys).size).toBe(connectorItemSkipReasons.length);
  expect(googleDriveSkipReasonKey("weird")).toMatch(/\.unknown$/);
});

test("tells the user to reconnect when the account is unavailable", () => {
  expect(
    googleDrivePickerErrorKey("CONNECTOR_OAUTH_ACCOUNT_UNAVAILABLE"),
  ).toMatch(/\.reconnect$/);
  expect(googleDrivePickerErrorKey("GOOGLE_DRIVE_CONNECTOR_NOT_FOUND")).toMatch(
    /\.notFound$/,
  );
  expect(googleDrivePickerErrorKey(undefined)).toMatch(/\.generic$/);
  expect(googleDrivePickerErrorKey("SOMETHING_ELSE")).toMatch(/\.generic$/);
});

describe("GOOGLE_DRIVE_MAX_FILES", () => {
  test("is 500", () => {
    expect(GOOGLE_DRIVE_MAX_FILES).toBe(500);
  });
});

describe("googleDriveFileState", () => {
  const externalId = googleDriveExternalId("abc");
  const runStart = new Date("2026-11-13T10:00:00.000Z");
  const beforeRun = new Date("2026-11-13T09:00:00.000Z");
  const afterRun = new Date("2026-11-13T11:00:00.000Z");

  function succeededRun(
    skippedItems: Array<{ externalId: string; reason: string }> = [],
  ) {
    return { status: "succeeded", startedAt: runStart, skippedItems };
  }

  test("reports a skipped file with its reason", () => {
    expect(
      googleDriveFileState({
        fileId: "abc",
        source: null,
        latestRun: succeededRun([{ externalId, reason: "too_large" }]),
        selectionChangedAt: null,
      }),
    ).toEqual({ kind: "skipped", reason: "too_large" });
  });

  test("skipped wins over a stale indexed source", () => {
    expect(
      googleDriveFileState({
        fileId: "abc",
        source: { status: "indexed" },
        latestRun: succeededRun([{ externalId, reason: "needs_ocr" }]),
        selectionChangedAt: null,
      }),
    ).toEqual({ kind: "skipped", reason: "needs_ocr" });
  });

  test("maps an active source's status to indexed, processing, or failed", () => {
    expect(
      googleDriveFileState({
        fileId: "abc",
        source: { status: "indexed" },
        latestRun: succeededRun(),
        selectionChangedAt: null,
      }).kind,
    ).toBe("indexed");
    expect(
      googleDriveFileState({
        fileId: "abc",
        source: { status: "failed" },
        latestRun: succeededRun(),
        selectionChangedAt: null,
      }).kind,
    ).toBe("failed");
    for (const status of ["created", "queued", "processing"]) {
      expect(
        googleDriveFileState({
          fileId: "abc",
          source: { status },
          latestRun: succeededRun(),
          selectionChangedAt: null,
        }).kind,
      ).toBe("processing");
    }
  });

  test("shows unavailable for a file with no source when the selection was not changed in this session", () => {
    expect(
      googleDriveFileState({
        fileId: "abc",
        source: null,
        latestRun: succeededRun(),
        selectionChangedAt: null,
      }).kind,
    ).toBe("unavailable");
  });

  test("shows unavailable once a run that started after the change has succeeded", () => {
    expect(
      googleDriveFileState({
        fileId: "abc",
        source: null,
        latestRun: { status: "succeeded", startedAt: afterRun, skippedItems: [] },
        selectionChangedAt: runStart,
      }).kind,
    ).toBe("unavailable");
  });

  test("shows waiting, not unavailable, for a file added after the latest successful run started", () => {
    expect(
      googleDriveFileState({
        fileId: "abc",
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

  test("run in progress shows waiting, not unavailable", () => {
    for (const status of ["queued", "running"]) {
      expect(
        googleDriveFileState({
          fileId: "abc",
          source: null,
          latestRun: { status, startedAt: null, skippedItems: [] },
          selectionChangedAt: null,
        }).kind,
      ).toBe("waiting");
    }
  });

  test("waits when there is no run yet or the latest run failed", () => {
    expect(
      googleDriveFileState({
        fileId: "abc",
        source: null,
        latestRun: null,
        selectionChangedAt: null,
      }).kind,
    ).toBe("waiting");
    expect(
      googleDriveFileState({
        fileId: "abc",
        source: null,
        latestRun: { status: "failed", startedAt: runStart, skippedItems: [] },
        selectionChangedAt: null,
      }).kind,
    ).toBe("waiting");
  });
});

describe("googleDriveFileName", () => {
  const skippedItems = [
    { externalId: "file:skipped-1", title: "Scanned contract.pdf" },
    { externalId: "file:skipped-2", title: null },
    { externalId: "file:skipped-3", title: "   " },
  ];

  test("uses the source title when the file has a source", () => {
    expect(
      googleDriveFileName({
        fileId: "skipped-1",
        source: { title: " Quarterly report " },
        skippedItems,
      }),
    ).toBe("Quarterly report");
  });

  test("uses the title recorded with the skip when there is no source", () => {
    expect(
      googleDriveFileName({ fileId: "skipped-1", source: null, skippedItems }),
    ).toBe("Scanned contract.pdf");
  });

  test("falls back to the file id when no title is known", () => {
    expect(
      googleDriveFileName({ fileId: "skipped-2", source: null, skippedItems }),
    ).toBe("skipped-2");
    expect(
      googleDriveFileName({ fileId: "skipped-3", source: null, skippedItems }),
    ).toBe("skipped-3");
    expect(
      googleDriveFileName({
        fileId: "unknown",
        source: { title: "" },
        skippedItems,
      }),
    ).toBe("unknown");
  });
});

describe("commitGoogleDriveSelection", () => {
  test("does not sync when the save fails", async () => {
    const sync = vi.fn();
    const result = await commitGoogleDriveSelection({
      save: async () => false,
      sync,
    });
    expect(result).toBe(false);
    expect(sync).not.toHaveBeenCalled();
  });

  test("syncs after a successful save", async () => {
    const sync = vi.fn();
    const result = await commitGoogleDriveSelection({
      save: async () => true,
      sync,
    });
    expect(result).toBe(true);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  test("awaits the save before syncing", async () => {
    const order: string[] = [];
    const sync = vi.fn(() => {
      order.push("sync");
    });
    await commitGoogleDriveSelection({
      save: async () => {
        order.push("save");
        return true;
      },
      sync,
    });
    expect(order).toEqual(["save", "sync"]);
  });
});
