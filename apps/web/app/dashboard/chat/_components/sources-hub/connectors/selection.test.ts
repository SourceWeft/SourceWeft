import { describe, expect, it, test, vi } from "vitest";
import type { ConnectorSelectionSpec } from "@sourceweft/sdk";
import { connectorItemSkipReasons } from "@sourceweft/contracts";
import enMessages from "../../../../../../messages/en.json";
import {
  commitSelection,
  mergeSelection,
  readSelection,
  removeSelectionItem,
  selectionErrorKey,
  selectionSkipReasonKey,
  toggleSelection,
} from "./selection";

const spec: ConnectorSelectionSpec = {
  actions: { browse: "dropbox.browse", describe: "dropbox.describe" },
  kinds: ["folder", "file"],
  maxItems: 500,
};

describe("readSelection", () => {
  test("keeps entries with a non-empty string id and a kind listed in spec.kinds", () => {
    expect(
      readSelection(
        {
          items: [
            { id: "id:abc", kind: "file" },
            { id: "id:def", kind: "folder" },
          ],
        },
        spec,
      ),
    ).toEqual([
      { id: "id:abc", kind: "file" },
      { id: "id:def", kind: "folder" },
    ]);
  });

  test("returns an empty array when items is missing or not an array", () => {
    expect(readSelection({}, spec)).toEqual([]);
    expect(readSelection({ items: "nope" }, spec)).toEqual([]);
  });

  // Review Focus 4
  it("drops entries whose kind the manifest no longer lists, and malformed entries", () => {
    expect(
      readSelection(
        {
          items: [
            { id: "id:a", kind: "file" },
            { id: "id:b", kind: "paper" },
            { id: "", kind: "file" },
            "x",
            { id: 5, kind: "file" },
            { kind: "file" },
            { id: "id:abc" },
          ],
        },
        spec,
      ),
    ).toEqual([{ id: "id:a", kind: "file" }]);
    expect(readSelection({ items: "nope" }, spec)).toEqual([]);
  });

  test("drops an id longer than 512 characters", () => {
    const tooLong = "a".repeat(513);
    expect(
      readSelection({ items: [{ id: tooLong, kind: "file" }] }, spec),
    ).toEqual([]);
  });
});

describe("toggleSelection", () => {
  test("adds then removes", () => {
    const added = toggleSelection([], { id: "id:a", kind: "file" });
    expect(added).toEqual([{ id: "id:a", kind: "file" }]);

    const removed = toggleSelection(added, { id: "id:a", kind: "file" });
    expect(removed).toEqual([]);
  });

  test("adding one item leaves other existing items untouched", () => {
    const current = [
      { id: "id:a", kind: "file" as const },
      { id: "id:b", kind: "folder" as const },
    ];
    expect(toggleSelection(current, { id: "id:c", kind: "file" })).toEqual([
      ...current,
      { id: "id:c", kind: "file" },
    ]);
  });
});

describe("mergeSelection", () => {
  test("appends new picks and drops duplicates by id", () => {
    const current = [{ id: "id:a", kind: "file" as const }];
    const picked = [
      { id: "id:a", kind: "file" as const },
      { id: "id:b", kind: "folder" as const },
    ];
    expect(mergeSelection(current, picked, 500)).toEqual({
      ok: true,
      items: [
        { id: "id:a", kind: "file" },
        { id: "id:b", kind: "folder" },
      ],
      added: 1,
    });
  });

  test("rejects whole selection past the limit", () => {
    const current = Array.from({ length: 499 }, (_, i) => ({
      id: `id:f${i}`,
      kind: "file" as const,
    }));
    const picked = [
      { id: "id:x", kind: "file" as const },
      { id: "id:y", kind: "file" as const },
    ];
    expect(mergeSelection(current, picked, 500)).toEqual({
      ok: false,
      reason: "limit",
      limit: 500,
      attempted: 501,
    });
  });

  test("allows exactly the limit", () => {
    const current = Array.from({ length: 499 }, (_, i) => ({
      id: `id:f${i}`,
      kind: "file" as const,
    }));
    const result = mergeSelection(
      current,
      [{ id: "id:x", kind: "file" as const }],
      500,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.items).toHaveLength(500);
    }
  });
});

describe("removeSelectionItem", () => {
  test("removes one item by id, preserving order of the rest", () => {
    const current = [
      { id: "id:a", kind: "file" as const },
      { id: "id:b", kind: "folder" as const },
    ];
    expect(removeSelectionItem(current, "id:a")).toEqual([
      { id: "id:b", kind: "folder" },
    ]);
  });

  test("removing the last item leaves an empty selection", () => {
    expect(
      removeSelectionItem([{ id: "id:a", kind: "file" as const }], "id:a"),
    ).toEqual([]);
  });
});

describe("selectionSkipReasonKey", () => {
  test("maps every skip reason to a message key and unknown ones to a fallback", () => {
    const keys = connectorItemSkipReasons.map((reason) =>
      selectionSkipReasonKey(reason),
    );
    expect(connectorItemSkipReasons).toContain("unreadable");
    expect(new Set(keys).size).toBe(connectorItemSkipReasons.length);
    // No canonical reason may collapse into the unknown fallback key.
    expect(keys).not.toContain("connectors.selection.skipReason.unknown");
    expect(selectionSkipReasonKey("weird")).toMatch(/\.unknown$/);
    expect(selectionSkipReasonKey("too_large")).toBe(
      "connectors.selection.skipReason.too_large",
    );
  });

  test("maps known reasons and falls back to unknown", () => {
    expect(selectionSkipReasonKey("too_large")).toBe(
      "connectors.selection.skipReason.too_large",
    );
    expect(selectionSkipReasonKey("needs_ocr")).toBe(
      "connectors.selection.skipReason.needs_ocr",
    );
    expect(selectionSkipReasonKey("weird")).toBe(
      "connectors.selection.skipReason.unknown",
    );
  });

  test("every canonical reason's key has English copy", () => {
    const skipReasonMessages: Record<string, unknown> =
      enMessages.dashboardSourcesHub.connectors.selection.skipReason;
    for (const reason of connectorItemSkipReasons) {
      const key = selectionSkipReasonKey(reason);
      const segment = key.split(".").pop() as string;
      expect(typeof skipReasonMessages[segment]).toBe("string");
      expect((skipReasonMessages[segment] as string).length).toBeGreaterThan(
        0,
      );
    }
  });
});

describe("selectionErrorKey", () => {
  it.each([
    ["GITHUB_REAUTH_REQUIRED", "connectors.selection.error.reconnect"],
    ["CONNECTOR_REAUTH_REQUIRED", "connectors.selection.error.reconnect"],
    [
      "CONNECTOR_OAUTH_ACCOUNT_UNAVAILABLE",
      "connectors.selection.error.reconnect",
    ],
    [
      "CONNECTOR_SELECTION_NOT_FOUND",
      "connectors.selection.error.notFound",
    ],
    [
      "CONNECTOR_OAUTH_ACCOUNT_NOT_FOUND",
      "connectors.selection.error.reconnect",
    ],
    ["CONNECTOR_OAUTH_REFRESH_BUSY", "connectors.selection.error.tryLater"],
    ["CONNECTOR_OAUTH_REFRESH_TIMEOUT", "connectors.selection.error.tryLater"],
    // A platform code ending in _NOT_FOUND must not be mistaken for an item.
    ["CONNECTOR_ADAPTER_NOT_FOUND", "connectors.selection.error.generic"],
    ["DROPBOX_NOT_FOUND", "connectors.selection.error.notFoundItem"],
    ["JIRA_RATE_LIMITED", "connectors.selection.error.tryLater"],
    ["DROPBOX_UNAVAILABLE", "connectors.selection.error.tryLater"],
    ["DROPBOX_CURSOR_RESET", "connectors.selection.error.reopen"],
    ["DROPBOX_INVALID_REQUEST", "connectors.selection.error.generic"],
    [undefined, "connectors.selection.error.generic"],
  ])("maps %s to %s", (code, key) => {
    expect(selectionErrorKey(code)).toBe(key);
  });
});

describe("commitSelection", () => {
  test("does not sync when the save fails", async () => {
    const sync = vi.fn();
    const result = await commitSelection({
      save: async () => false,
      sync,
    });
    expect(result).toBe(false);
    expect(sync).not.toHaveBeenCalled();
  });

  test("syncs after a successful save", async () => {
    const sync = vi.fn();
    const result = await commitSelection({
      save: async () => true,
      sync,
    });
    expect(result).toBe(true);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("commitSelection saves without syncing when no sync is given", async () => {
    const result = await commitSelection({ save: async () => true });
    expect(result).toBe(true);
  });
});
