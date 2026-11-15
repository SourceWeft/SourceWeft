// @vitest-environment jsdom

import { act, createElement } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import {
  HttpClientError,
  type DropboxBrowseEntry,
  type DropboxBrowseResult,
} from "@sourceweft/sdk";
import {
  button,
  buttons,
  click,
  flush,
  mountWithIntl,
  typeInto,
  unmountAll,
} from "@/test/react";

const { dropboxBrowse, dropboxSearch } = vi.hoisted(() => ({
  dropboxBrowse: vi.fn(),
  dropboxSearch: vi.fn(),
}));

vi.mock("../../../../../../lib/sdk", () => ({
  connectorsClient: { dropboxBrowse, dropboxSearch },
}));

import { DropboxBrowser } from "./dropbox-browser";
import type { DropboxSelectionItem } from "./dropbox-selection";

function entry(
  id: string,
  name: string,
  overrides: Partial<DropboxBrowseEntry> = {},
): DropboxBrowseEntry {
  return {
    id,
    kind: "file",
    name,
    pathDisplay: `/${name}`,
    size: 10,
    serverModified: "2026-11-01T00:00:00Z",
    supported: true,
    ...overrides,
  };
}

function folderEntry(id: string, name: string, path = `/${name}`) {
  return entry(id, name, { kind: "folder", pathDisplay: path, size: null });
}

function page(overrides: Partial<DropboxBrowseResult>): DropboxBrowseResult {
  return {
    folder: null,
    breadcrumbs: [],
    entries: [],
    cursor: "cursor-end",
    hasMore: false,
    ...overrides,
  };
}

const rootPage = page({
  entries: [
    folderEntry("id:projects", "Projects"),
    entry("id:readme", "readme.md"),
  ],
});

const projectsPage = page({
  folder: { id: "id:projects", name: "Projects", pathDisplay: "/Projects" },
  entries: [
    folderEntry("id:q3", "Q3", "/Projects/Q3"),
    entry("id:plan", "plan.pdf", { pathDisplay: "/Projects/plan.pdf" }),
  ],
});

const q3Page = page({
  folder: { id: "id:q3", name: "Q3", pathDisplay: "/Projects/Q3" },
  breadcrumbs: [{ id: "id:projects", name: "Projects" }],
  entries: [entry("id:report", "report.docx")],
});

/** Answer `dropboxBrowse` by folder id (root when absent). */
function browseByFolder(pages: Record<string, DropboxBrowseResult>) {
  dropboxBrowse.mockImplementation(
    async (_ws: string, _c: string, input: { folderId?: string | null }) =>
      pages[input.folderId ?? "root"] ?? page({}),
  );
}

async function open(
  props: {
    initialSelection?: DropboxSelectionItem[];
    onConfirm?: (items: DropboxSelectionItem[]) => Promise<boolean>;
  } = {},
) {
  const onOpenChange = vi.fn();
  const onConfirm = props.onConfirm ?? vi.fn(async () => true);
  await mountWithIntl(
    createElement(DropboxBrowser, {
      open: true,
      onOpenChange,
      workspaceId: "ws-1",
      connectorId: "c-1",
      initialSelection: props.initialSelection ?? [],
      onConfirm,
    }),
  );
  await flush(5);
  return { onOpenChange, onConfirm };
}

function dialog() {
  return document.querySelector<HTMLElement>('[role="dialog"]')!;
}

function rowNames() {
  return [...dialog().querySelectorAll("[data-dropbox-entry]")].map((row) =>
    row.getAttribute("data-dropbox-entry"),
  );
}

function checkbox(name: string) {
  return dialog().querySelector<HTMLButtonElement>(
    `[role="checkbox"][aria-label="Select ${name}"]`,
  )!;
}

function currentCrumb() {
  return dialog().querySelector('[aria-current="page"]')?.textContent;
}

beforeEach(() => {
  dropboxBrowse.mockReset();
  dropboxSearch.mockReset();
});

afterEach(async () => {
  vi.useRealTimers();
  await unmountAll();
});

test("opens at root and enters a folder", async () => {
  browseByFolder({ root: rootPage, "id:projects": projectsPage });

  await open();

  expect(dropboxBrowse).toHaveBeenCalledWith("ws-1", "c-1", {});
  const node = dialog();
  // The nested dialog is labelled and described for assistive tech.
  const title = document.getElementById(node.getAttribute("aria-labelledby")!);
  expect(title?.textContent).toBe("Choose from Dropbox");
  expect(node.getAttribute("aria-describedby")).toBeTruthy();
  expect(currentCrumb()).toBe("Dropbox");
  expect(rowNames()).toEqual(["Projects", "readme.md"]);

  await click(button("Projects", node));
  await flush(5);

  expect(dropboxBrowse).toHaveBeenLastCalledWith("ws-1", "c-1", {
    folderId: "id:projects",
  });
  expect(rowNames()).toEqual(["Q3", "plan.pdf"]);
  expect(currentCrumb()).toBe("Projects");
  expect(button("Dropbox", dialog())).toBeTruthy();
});

test("breadcrumb returns to parent", async () => {
  browseByFolder({
    root: rootPage,
    "id:projects": projectsPage,
    "id:q3": q3Page,
  });
  await open();
  await click(button("Projects", dialog()));
  await flush(5);
  await click(button("Q3", dialog()));
  await flush(5);
  expect(currentCrumb()).toBe("Q3");
  expect(rowNames()).toEqual(["report.docx"]);

  // The parent appears as a crumb between the root and the current folder.
  const crumbs = dialog().querySelector("nav")!;
  await click(button("Projects", crumbs));
  await flush(5);

  expect(dropboxBrowse).toHaveBeenLastCalledWith("ws-1", "c-1", {
    folderId: "id:projects",
  });
  expect(currentCrumb()).toBe("Projects");
  expect(rowNames()).toEqual(["Q3", "plan.pdf"]);

  await click(button("Dropbox", crumbs));
  await flush(5);
  expect(dropboxBrowse).toHaveBeenLastCalledWith("ws-1", "c-1", {});
  expect(currentCrumb()).toBe("Dropbox");
});

test("search replaces the list and clearing restores it", async () => {
  browseByFolder({ root: rootPage });
  dropboxSearch.mockResolvedValue({
    entries: [
      entry("id:report", "report.docx", {
        pathDisplay: "/Projects/Q3/report.docx",
      }),
    ],
    cursor: "s-1",
    hasMore: false,
  });
  await open();
  vi.useFakeTimers();

  const search = dialog().querySelector<HTMLInputElement>(
    'input[type="search"]',
  )!;
  await act(async () => typeInto(search, "rep"));
  await act(async () => vi.advanceTimersByTime(299));
  expect(dropboxSearch).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTime(1));
  await flush(5);

  expect(dropboxSearch).toHaveBeenCalledTimes(1);
  expect(dropboxSearch).toHaveBeenCalledWith("ws-1", "c-1", { query: "rep" });
  expect(rowNames()).toEqual(["report.docx"]);
  expect(dialog().textContent).toContain("/Projects/Q3/report.docx");

  // Whitespace alone is not a query.
  await act(async () => typeInto(search, "   "));
  await act(async () => vi.advanceTimersByTime(300));
  await flush(5);

  expect(rowNames()).toEqual(["Projects", "readme.md"]);
  expect(dropboxSearch).toHaveBeenCalledTimes(1);
  // The folder listing is restored without fetching it again.
  expect(dropboxBrowse).toHaveBeenCalledTimes(1);
});

test("selecting and unselecting files and folders updates the count", async () => {
  browseByFolder({ root: rootPage });
  const { onConfirm, onOpenChange } = await open({
    initialSelection: [{ id: "id:other", kind: "file" }],
  });

  expect(dialog().textContent).toContain("0 selected");
  expect(dialog().textContent).toContain(
    "Folders sync up to 1,000 files in total",
  );
  expect(button("Add", dialog()).disabled).toBe(true);

  await click(checkbox("Projects"));
  await click(checkbox("readme.md"));
  expect(dialog().textContent).toContain("2 selected");
  expect(checkbox("Projects").getAttribute("aria-checked")).toBe("true");

  await click(checkbox("readme.md"));
  expect(dialog().textContent).toContain("1 selected");
  expect(checkbox("readme.md").getAttribute("aria-checked")).toBe("false");

  await click(button("Add", dialog()));
  await flush(5);

  expect(onConfirm).toHaveBeenCalledWith([
    { id: "id:projects", kind: "folder" },
  ]);
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

test("an item already in the selection shows as added and cannot be picked again", async () => {
  browseByFolder({ root: rootPage });
  await open({ initialSelection: [{ id: "id:readme", kind: "file" }] });

  const box = checkbox("readme.md");
  expect(box.getAttribute("aria-checked")).toBe("true");
  expect(box.disabled).toBe(true);
  expect(
    dialog()
      .querySelector('[data-dropbox-entry="readme.md"]')!
      .getAttribute("title"),
  ).toBe("Already added");
  expect(dialog().textContent).toContain("0 selected");
});

test("a failed confirm keeps the dialog open", async () => {
  browseByFolder({ root: rootPage });
  const { onOpenChange } = await open({ onConfirm: vi.fn(async () => false) });

  await click(checkbox("readme.md"));
  await click(button("Add", dialog()));
  await flush(5);

  expect(onOpenChange).not.toHaveBeenCalled();
  expect(dialog().textContent).toContain("1 selected");
});

test("unsupported files cannot be selected", async () => {
  browseByFolder({
    root: page({
      entries: [entry("id:zip", "archive.zip", { supported: false })],
    }),
  });
  await open();

  const row = dialog().querySelector<HTMLElement>(
    '[data-dropbox-entry="archive.zip"]',
  )!;
  expect(row.getAttribute("title")).toBe("This file type cannot be indexed");
  expect(row.getAttribute("aria-disabled")).toBe("true");
  const box = checkbox("archive.zip");
  expect(box.disabled).toBe(true);

  await click(box);
  expect(box.getAttribute("aria-checked")).toBe("false");
  expect(dialog().textContent).toContain("0 selected");
});

test("load more appends entries", async () => {
  dropboxBrowse.mockImplementation(
    async (
      _ws: string,
      _c: string,
      input: { folderId?: string | null; cursor?: string },
    ) => {
      if (input.cursor === "page-2") {
        return page({ entries: [entry("id:b", "b.pdf")], hasMore: false });
      }
      if (input.folderId === "id:q3") {
        return page({
          folder: { id: "id:q3", name: "Q3", pathDisplay: "/Projects/Q3" },
          breadcrumbs: [{ id: "id:projects", name: "Projects" }],
          entries: [entry("id:a", "a.pdf")],
          cursor: "page-2",
          hasMore: true,
        });
      }
      return page({ entries: [folderEntry("id:q3", "Q3")] });
    },
  );
  await open();
  await click(button("Q3", dialog()));
  await flush(5);
  expect(rowNames()).toEqual(["a.pdf"]);

  await click(button("Load more", dialog()));
  await flush(5);

  expect(dropboxBrowse).toHaveBeenLastCalledWith("ws-1", "c-1", {
    cursor: "page-2",
  });
  expect(rowNames()).toEqual(["a.pdf", "b.pdf"]);
  // The continuation page carries no folder; the first page's is kept.
  expect(currentCrumb()).toBe("Q3");
  expect(button("Projects", dialog().querySelector("nav")!)).toBeTruthy();
  expect(buttons("Load more", dialog())).toHaveLength(0);
});

test("reauth error shows the reconnect message", async () => {
  dropboxBrowse.mockRejectedValue(
    new HttpClientError({
      message: "Dropbox authorization expired",
      status: 401,
      statusText: "Unauthorized",
      code: "DROPBOX_REAUTH_REQUIRED",
    }),
  );
  await open();

  expect(dialog().textContent).toContain(
    "Your Dropbox account needs reconnecting. Reconnect it, then try again.",
  );
  expect(dialog().textContent).not.toContain("Dropbox authorization expired");
});
