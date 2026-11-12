import { describe, expect, test } from "vitest";
import { connectorItemSkipReasons } from "@sourceweft/contracts";
import {
  GOOGLE_DRIVE_MAX_FILES,
  googleDriveExternalId,
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

  test("reports a skipped file with its reason", () => {
    const state = googleDriveFileState({
      fileId: "abc",
      source: null,
      latestRun: {
        status: "succeeded",
        skippedItems: [{ externalId, reason: "too_large" }],
      },
    });
    expect(state).toEqual({ kind: "skipped", reason: "too_large" });
  });

  test("skipped wins over a stale indexed source", () => {
    const state = googleDriveFileState({
      fileId: "abc",
      source: { status: "indexed" },
      latestRun: {
        status: "succeeded",
        skippedItems: [{ externalId, reason: "needs_ocr" }],
      },
    });
    expect(state).toEqual({ kind: "skipped", reason: "needs_ocr" });
  });

  test("maps an active source's status to indexed, processing, or failed", () => {
    const run = { status: "succeeded", skippedItems: [] };
    expect(
      googleDriveFileState({
        fileId: "abc",
        source: { status: "indexed" },
        latestRun: run,
      }).kind,
    ).toBe("indexed");
    expect(
      googleDriveFileState({
        fileId: "abc",
        source: { status: "failed" },
        latestRun: run,
      }).kind,
    ).toBe("failed");
    for (const status of ["created", "queued", "processing"]) {
      expect(
        googleDriveFileState({
          fileId: "abc",
          source: { status },
          latestRun: run,
        }).kind,
      ).toBe("processing");
    }
  });

  test("reports unavailable when a successful run left no active source", () => {
    const state = googleDriveFileState({
      fileId: "abc",
      source: null,
      latestRun: { status: "succeeded", skippedItems: [] },
    });
    expect(state.kind).toBe("unavailable");
  });

  test("run in progress shows waiting, not unavailable", () => {
    for (const status of ["queued", "running"]) {
      expect(
        googleDriveFileState({
          fileId: "abc",
          source: null,
          latestRun: { status, skippedItems: [] },
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
      }).kind,
    ).toBe("waiting");
    expect(
      googleDriveFileState({
        fileId: "abc",
        source: null,
        latestRun: { status: "failed", skippedItems: [] },
      }).kind,
    ).toBe("waiting");
  });
});
