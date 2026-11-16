import { describe, expect, test } from "vitest";
import { File, Folder } from "lucide-react";
import {
  selectionIconFor,
  selectionPresenterFor,
  selectionPresenters,
} from "./selection-presenters";

describe("selectionPresenters.dropbox", () => {
  const presenter = selectionPresenters.dropbox;

  test("kindIcons map folder and file", () => {
    expect(presenter.kindIcons.folder).toBe(Folder);
    expect(presenter.kindIcons.file).toBe(File);
  });

  describe("externalIdFor", () => {
    test("prefixes a file id with file:", () => {
      expect(
        presenter.indexing?.externalIdFor({ id: "id:abc", kind: "file" }),
      ).toBe("file:id:abc");
    });

    test("returns null for a folder", () => {
      expect(
        presenter.indexing?.externalIdFor({ id: "id:abc", kind: "folder" }),
      ).toBeNull();
    });
  });

  describe("containerIndexedCount", () => {
    const item = { id: "id:folder", kind: "folder" as const };

    test("folder counts match whole path segments only", () => {
      const sources = [
        { status: "indexed", metadata: { pathLower: "/a/b/x.pdf" } },
        { status: "indexed", metadata: { pathLower: "/a/b/c/y.pdf" } },
        { status: "indexed", metadata: { pathLower: "/a/bc/z.pdf" } },
        { status: "indexed", metadata: { pathLower: "/a/b" } },
      ];
      const described = {
        id: "id:folder",
        kind: "folder" as const,
        name: "b",
        detail: null,
        exists: true,
        meta: { pathLower: "/a/b" },
      };
      expect(
        presenter.indexing?.containerIndexedCount({ item, described, sources }),
      ).toBe(2);
    });

    test("counts only indexed sources", () => {
      const sources = [
        { status: "indexed", metadata: { pathLower: "/a/b/x.pdf" } },
        { status: "processing", metadata: { pathLower: "/a/b/y.pdf" } },
        { status: "failed", metadata: { pathLower: "/a/b/z.pdf" } },
        { status: "pending", metadata: { pathLower: "/a/b/w.pdf" } },
      ];
      const described = {
        id: "id:folder",
        kind: "folder" as const,
        name: "b",
        detail: null,
        exists: true,
        meta: { pathLower: "/a/b" },
      };
      expect(
        presenter.indexing?.containerIndexedCount({ item, described, sources }),
      ).toBe(1);
    });

    test("is defensive about archived sources even though listSources already excludes them", () => {
      const sources = [
        { status: "archived", metadata: { pathLower: "/a/b/x.pdf" } },
        { status: "indexed", metadata: { pathLower: "/a/b/y.pdf" } },
      ];
      const described = {
        id: "id:folder",
        kind: "folder" as const,
        name: "b",
        detail: null,
        exists: true,
        meta: { pathLower: "/a/b" },
      };
      expect(
        presenter.indexing?.containerIndexedCount({ item, described, sources }),
      ).toBe(1);
    });

    test("ignores sources with a missing or non-string pathLower", () => {
      const sources = [
        { status: "indexed", metadata: {} },
        { status: "indexed", metadata: { pathLower: 42 } },
      ];
      const described = {
        id: "id:folder",
        kind: "folder" as const,
        name: "b",
        detail: null,
        exists: true,
        meta: { pathLower: "/a/b" },
      };
      expect(
        presenter.indexing?.containerIndexedCount({ item, described, sources }),
      ).toBe(0);
    });

    test("returns null when meta.pathLower is absent", () => {
      const sources = [
        { status: "indexed", metadata: { pathLower: "/a/b/x.pdf" } },
      ];
      const described = {
        id: "id:folder",
        kind: "folder" as const,
        name: "b",
        detail: null,
        exists: true,
        meta: {},
      };
      expect(
        presenter.indexing?.containerIndexedCount({ item, described, sources }),
      ).toBeNull();
    });

    test("returns null when described is null", () => {
      const sources = [
        { status: "indexed", metadata: { pathLower: "/a/b/x.pdf" } },
      ];
      expect(
        presenter.indexing?.containerIndexedCount({
          item,
          described: null,
          sources,
        }),
      ).toBeNull();
    });

    test("returns null when meta.pathLower is not a string", () => {
      const sources = [
        { status: "indexed", metadata: { pathLower: "/a/b/x.pdf" } },
      ];
      const described = {
        id: "id:folder",
        kind: "folder" as const,
        name: "b",
        detail: null,
        exists: true,
        meta: { pathLower: 42 },
      };
      expect(
        presenter.indexing?.containerIndexedCount({ item, described, sources }),
      ).toBeNull();
    });
  });
});

describe("selectionPresenterFor", () => {
  test("returns the dropbox entry for type dropbox", () => {
    expect(selectionPresenterFor("dropbox")).toBe(selectionPresenters.dropbox);
  });

  test("returns a generic fallback with no indexing for an unknown type", () => {
    const presenter = selectionPresenterFor("unknown");
    expect(presenter.kindIcons).toEqual({});
    expect(presenter.indexing).toBeUndefined();
  });
});

describe("selectionIconFor", () => {
  test("returns the presenter's icon for a known kind", () => {
    const presenter = selectionPresenters.dropbox;
    expect(selectionIconFor(presenter, "file", false)).toBe(File);
    expect(selectionIconFor(presenter, "folder", true)).toBe(Folder);
  });

  test("falls back to Folder for an expandable entry with no presenter icon", () => {
    const presenter = selectionPresenterFor("unknown");
    expect(selectionIconFor(presenter, "project", true)).toBe(Folder);
  });

  test("falls back to File for a non-expandable entry with no presenter icon", () => {
    const presenter = selectionPresenterFor("unknown");
    expect(selectionIconFor(presenter, "ticket", false)).toBe(File);
  });
});
