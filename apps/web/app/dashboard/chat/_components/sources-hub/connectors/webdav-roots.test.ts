import { describe, expect, test } from "vitest";

import {
  canonicalizeWebdavRoots,
  isDavFilesConnector,
  normalizeWebdavRoot,
  parseWebdavRootsInput,
  webdavRootsToSelectionItems,
  webdavSelectionItemsToRoots,
  WEBDAV_MAX_ROOTS,
} from "./webdav-roots";

describe("isDavFilesConnector", () => {
  test("covers both DAV files connectors and nothing else", () => {
    expect(isDavFilesConnector("webdav")).toBe(true);
    expect(isDavFilesConnector("nextcloud")).toBe(true);
    expect(isDavFilesConnector("dropbox")).toBe(false);
    expect(isDavFilesConnector("google_drive")).toBe(false);
    expect(isDavFilesConnector("rss")).toBe(false);
    expect(isDavFilesConnector("")).toBe(false);
  });
});

describe("normalizeWebdavRoot", () => {
  test("adds a leading and trailing slash and collapses doubles", () => {
    expect(normalizeWebdavRoot("Documents")).toBe("/Documents/");
    expect(normalizeWebdavRoot("/Documents")).toBe("/Documents/");
    expect(normalizeWebdavRoot("/Documents/")).toBe("/Documents/");
    expect(normalizeWebdavRoot("//a//b//")).toBe("/a/b/");
    expect(normalizeWebdavRoot("/a/./b")).toBe("/a/b/");
  });

  test("the endpoint root normalizes to '/'", () => {
    expect(normalizeWebdavRoot("")).toBe("/");
    expect(normalizeWebdavRoot("/")).toBe("/");
    expect(normalizeWebdavRoot(".")).toBe("/");
  });

  test("rejects traversal and control characters", () => {
    expect(normalizeWebdavRoot("/a/../b")).toBeNull();
    expect(normalizeWebdavRoot("..")).toBeNull();
    expect(normalizeWebdavRoot("/a\u0000b")).toBeNull();
    expect(normalizeWebdavRoot("/a\\b")).toBeNull();
  });

  test("rejects an over-long root", () => {
    expect(normalizeWebdavRoot(`/${"x".repeat(520)}`)).toBeNull();
  });
});

describe("canonicalizeWebdavRoots", () => {
  test("de-duplicates", () => {
    expect(canonicalizeWebdavRoots(["/a/", "/a/"])).toEqual(["/a/"]);
  });

  test("drops a root nested inside another selected root", () => {
    expect(canonicalizeWebdavRoots(["/a/", "/a/b/"])).toEqual(["/a/"]);
    // The endpoint root subsumes everything else.
    expect(canonicalizeWebdavRoots(["/", "/a/", "/b/"])).toEqual(["/"]);
  });

  test("keeps siblings and prefix-but-not-descendant paths", () => {
    expect(canonicalizeWebdavRoots(["/a/", "/b/"])).toEqual(["/a/", "/b/"]);
    // `/a/bc` is a string prefix match of `/a/b` but not a path descendant.
    expect(canonicalizeWebdavRoots(["/a/b/", "/a/bc/"])).toEqual([
      "/a/b/",
      "/a/bc/",
    ]);
  });
});

describe("roots <-> selection items bridge", () => {
  test("roots become items with the trailing slash stripped", () => {
    expect(
      webdavRootsToSelectionItems({ roots: ["/Documents/", "/Photos/"] }),
    ).toEqual([
      { id: "/Documents", kind: "folder" },
      { id: "/Photos", kind: "folder" },
    ]);
  });

  test("the endpoint root maps to the id '/'", () => {
    expect(webdavRootsToSelectionItems({ roots: ["/"] })).toEqual([
      { id: "/", kind: "folder" },
    ]);
  });

  test("malformed roots are dropped, not thrown", () => {
    expect(
      webdavRootsToSelectionItems({ roots: ["/a/../b/", 42, "/ok/"] }),
    ).toEqual([{ id: "/ok", kind: "folder" }]);
    expect(webdavRootsToSelectionItems({})).toEqual([]);
  });

  test("items become roots with a trailing slash, de-nested and de-duplicated", () => {
    expect(
      webdavSelectionItemsToRoots([
        { id: "/Documents", kind: "folder" },
        { id: "/Documents/Reports", kind: "folder" },
        { id: "/Photos", kind: "folder" },
      ]),
    ).toEqual({ ok: true, roots: ["/Documents/", "/Photos/"] });
  });

  test("an empty selection is rejected", () => {
    expect(webdavSelectionItemsToRoots([])).toEqual({
      ok: false,
      reason: "empty",
    });
  });

  test("more than the maximum number of roots is rejected", () => {
    const items = Array.from({ length: WEBDAV_MAX_ROOTS + 1 }, (_, i) => ({
      id: `/folder-${i}`,
      kind: "folder" as const,
    }));
    expect(webdavSelectionItemsToRoots(items)).toEqual({
      ok: false,
      reason: "limit",
    });
  });
});

describe("parseWebdavRootsInput", () => {
  test("blank input defaults to the whole endpoint root", () => {
    expect(parseWebdavRootsInput("")).toEqual({ ok: true, roots: ["/"] });
    expect(parseWebdavRootsInput("   \n  ")).toEqual({
      ok: true,
      roots: ["/"],
    });
  });

  test("one path per line, normalized and de-nested", () => {
    expect(parseWebdavRootsInput("/Documents\n/Photos/\nDocuments")).toEqual({
      ok: true,
      roots: ["/Documents/", "/Photos/"],
    });
  });

  test("an invalid path fails the whole parse", () => {
    expect(parseWebdavRootsInput("/ok\n/a/../b")).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  test("too many paths are rejected", () => {
    const text = Array.from(
      { length: WEBDAV_MAX_ROOTS + 1 },
      (_, i) => `/folder-${i}`,
    ).join("\n");
    expect(parseWebdavRootsInput(text)).toEqual({ ok: false, reason: "limit" });
  });
});
