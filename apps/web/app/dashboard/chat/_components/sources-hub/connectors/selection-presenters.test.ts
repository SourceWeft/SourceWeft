import { describe, expect, test } from "vitest";
import {
  Building2,
  File,
  FileText,
  Folder,
  FolderGit2,
  FolderKanban,
  FolderTree,
  Globe,
  LibraryBig,
  MessageSquare,
  SquareKanban,
  Users,
} from "lucide-react";
import {
  selectionIconFor,
  selectionPresenterFor,
  selectionPresenters,
} from "./selection-presenters";

describe("selectionPresenters.dropbox", () => {
  const presenter = selectionPresenters.dropbox!;

  test("kindIcons map folder and file", () => {
    expect(presenter.kindIcons.folder).toBe(Folder);
    expect(presenter.kindIcons.file).toBe(FileText);
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

describe("selectionPresenters.github", () => {
  test("registers icons for account and repository and no indexing hooks", () => {
    const presenter = selectionPresenters.github!;
    expect(presenter.kindIcons.account).toBe(Building2);
    expect(presenter.kindIcons.repository).toBe(FolderGit2);
    expect(presenter.indexing).toBeUndefined();
  });
});

describe("selectionPresenters.linear", () => {
  const presenter = selectionPresenters.linear!;

  test("registers icons for team and project", () => {
    expect(presenter.kindIcons.team).toBe(Users);
    expect(presenter.kindIcons.project).toBe(FolderKanban);
  });

  test("has no indexing presenter (tools-only connector)", () => {
    expect(presenter.indexing).toBeUndefined();
  });
});

describe("selectionPresenters.jira", () => {
  test("presenter has an icon for every selection kind", () => {
    const presenter = selectionPresenters.jira!;
    expect(presenter.kindIcons.site).toBe(Globe);
    expect(presenter.kindIcons.project).toBe(SquareKanban);
  });
});

describe("selectionPresenters.confluence", () => {
  test("confluence presenter has an icon for every selection kind", () => {
    const presenter = selectionPresenters.confluence!;
    expect(presenter.kindIcons.site).toBe(Globe);
    expect(presenter.kindIcons.space).toBe(LibraryBig);
    expect(presenter.kindIcons.page).toBe(FileText);
  });
});

describe("selectionPresenters.zotero", () => {
  const presenter = selectionPresenters.zotero!;
  const collection = {
    id: "ABCD2345",
    kind: "collection",
    name: "Papers",
    detail: null,
    selectable: true,
    expandable: true,
    disabledReason: null,
    size: null,
    modifiedAt: null,
  } as never;

  test("registers an icon for collection", () => {
    expect(presenter.kindIcons.collection).toBe(FolderTree);
  });

  test("is indexed: a selected collection is a container that maps to no source", () => {
    expect(presenter.indexing?.externalIdFor(collection)).toBeNull();
    expect(
      presenter.indexing?.containerIndexedCount({
        item: collection,
        described: null,
        sources: [],
      }),
    ).toBeNull();
  });
});

describe("selectionPresenters.discourse", () => {
  const presenter = selectionPresenters.discourse!;
  const category = {
    id: "category:7",
    kind: "category",
    name: "Support",
    detail: null,
    selectable: true,
    expandable: true,
    disabledReason: null,
    size: null,
    modifiedAt: null,
  } as never;
  const topic = {
    id: "topic:42",
    kind: "topic",
    name: "How do I reset my password?",
    detail: null,
    selectable: true,
    expandable: false,
    disabledReason: null,
    size: null,
    modifiedAt: null,
  } as never;

  test("registers an icon for category and for topic", () => {
    expect(presenter.kindIcons.category).toBe(FolderTree);
    expect(presenter.kindIcons.topic).toBe(MessageSquare);
  });

  test("is indexed, so saving a selection triggers a sync", () => {
    expect(presenter.indexing).toBeDefined();
  });

  test("a topic maps to its own source; a category is a container that maps to none", () => {
    expect(presenter.indexing?.externalIdFor(topic)).toBe("discourse:topic:42");
    expect(presenter.indexing?.externalIdFor(category)).toBeNull();
  });

  test("a category's indexed sources cannot be counted", () => {
    expect(
      presenter.indexing?.containerIndexedCount({
        item: category,
        described: null,
        sources: [],
      }),
    ).toBeNull();
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
    const presenter = selectionPresenters.dropbox!;
    expect(selectionIconFor(presenter, "file", false)).toBe(FileText);
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
