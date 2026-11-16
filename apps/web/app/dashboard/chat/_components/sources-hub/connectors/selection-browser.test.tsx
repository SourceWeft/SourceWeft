// @vitest-environment jsdom

import { act, createElement } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import {
  HttpClientError,
  type ConnectorSelectionBrowseResult,
  type ConnectorSelectionEntry,
  type ConnectorSelectionItem,
  type ConnectorSelectionSpec,
} from "@sourceweft/sdk";
import {
  button,
  buttons,
  click,
  flush,
  messages,
  mountWithIntl,
  typeInto,
  unmountAll,
} from "@/test/react";

const { selectionBrowse, selectionSearch } = vi.hoisted(() => ({
  selectionBrowse: vi.fn(),
  selectionSearch: vi.fn(),
}));

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));

vi.mock("../../../../../../lib/sdk", () => ({
  connectorsClient: { selectionBrowse, selectionSearch },
}));

vi.mock("sonner", () => ({ toast: { error: toastError } }));

import { SelectionBrowser } from "./selection-browser";

const dropboxSpec: ConnectorSelectionSpec = {
  actions: {
    browse: "dropbox.browse",
    search: "dropbox.search",
    describe: "dropbox.describe",
  },
  kinds: ["folder", "file"],
  maxItems: 500,
};

function entry(
  id: string,
  name: string,
  overrides: Partial<ConnectorSelectionEntry> = {},
): ConnectorSelectionEntry {
  return {
    id,
    kind: "file",
    name,
    detail: `/${name}`,
    selectable: true,
    expandable: false,
    disabledReason: null,
    size: 10,
    modifiedAt: "2026-11-01T00:00:00Z",
    ...overrides,
  };
}

function folderEntry(id: string, name: string, path = `/${name}`) {
  return entry(id, name, {
    kind: "folder",
    expandable: true,
    detail: path,
    size: null,
  });
}

function page(
  overrides: Partial<ConnectorSelectionBrowseResult>,
): ConnectorSelectionBrowseResult {
  return {
    container: null,
    breadcrumbs: [],
    entries: [],
    cursor: "cursor-end",
    hasMore: false,
    helpLink: null,
    ...overrides,
  };
}

function container(id: string, name: string, detail: string) {
  return { id, kind: "folder", name, detail };
}

const rootPage = page({
  entries: [folderEntry("id:projects", "Projects"), entry("id:readme", "readme.md")],
});

const projectsPage = page({
  container: container("id:projects", "Projects", "/Projects"),
  entries: [
    folderEntry("id:q3", "Q3", "/Projects/Q3"),
    entry("id:plan", "plan.pdf", { detail: "/Projects/plan.pdf" }),
  ],
});

const q3Page = page({
  container: container("id:q3", "Q3", "/Projects/Q3"),
  breadcrumbs: [{ id: "id:projects", name: "Projects" }],
  entries: [entry("id:report", "report.docx")],
});

/** Answer `selectionBrowse` by container id (root when absent). */
function browseByContainer(pages: Record<string, ConnectorSelectionBrowseResult>) {
  selectionBrowse.mockImplementation(
    async (_ws: string, _c: string, input: { containerId?: string | null }) =>
      pages[input.containerId ?? "root"] ?? page({}),
  );
}

/** A full message catalog with extra keys merged under
 * `connectors.selection`, for the per-type keys Dropbox does not define. */
type Tree = Record<string, unknown>;

function withSelectionMessages(override: Tree) {
  const clone = structuredClone(messages) as unknown as Tree;
  const connectors = (
    (clone.dashboardSourcesHub as Tree).connectors as Tree
  ).selection as Tree;
  deepMerge(connectors, override);
  return clone as unknown as typeof messages;
}

function deepMerge(target: Tree, source: Tree): Tree {
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const existing = target[key];
      target[key] = deepMerge(
        existing && typeof existing === "object" ? { ...(existing as Tree) } : {},
        value as Tree,
      );
    } else {
      target[key] = value;
    }
  }
  return target;
}

async function open(
  props: {
    initialSelection?: ConnectorSelectionItem[];
    onConfirm?: (items: ConnectorSelectionItem[]) => Promise<boolean>;
    spec?: ConnectorSelectionSpec;
    connectorType?: string;
    providerName?: string;
  } = {},
  options?: { messages?: typeof messages },
) {
  const onOpenChange = vi.fn();
  const onConfirm = props.onConfirm ?? vi.fn(async () => true);
  await mountWithIntl(
    createElement(SelectionBrowser, {
      open: true,
      onOpenChange,
      workspaceId: "ws-1",
      connectorId: "c-1",
      connectorType: props.connectorType ?? "dropbox",
      providerName: props.providerName ?? "Dropbox",
      spec: props.spec ?? dropboxSpec,
      initialSelection: props.initialSelection ?? [],
      onConfirm,
    }),
    options,
  );
  await flush(5);
  return { onOpenChange, onConfirm };
}

function dialog() {
  return document.querySelector<HTMLElement>('[role="dialog"]')!;
}

function rowNames() {
  return [...dialog().querySelectorAll("[data-selection-entry]")].map((row) =>
    row.getAttribute("data-selection-entry"),
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
  selectionBrowse.mockReset();
  selectionSearch.mockReset();
  toastError.mockReset();
});

afterEach(async () => {
  vi.useRealTimers();
  await unmountAll();
});

test("opens at root and enters a folder", async () => {
  browseByContainer({ root: rootPage, "id:projects": projectsPage });

  await open();

  expect(selectionBrowse).toHaveBeenCalledWith("ws-1", "c-1", {});
  const node = dialog();
  // The nested dialog is labelled and described for assistive tech.
  const title = document.getElementById(node.getAttribute("aria-labelledby")!);
  expect(title?.textContent).toBe("Choose from Dropbox");
  expect(node.getAttribute("aria-describedby")).toBeTruthy();
  expect(currentCrumb()).toBe("Dropbox");
  expect(rowNames()).toEqual(["Projects", "readme.md"]);

  await click(button("Projects", node));
  await flush(5);

  expect(selectionBrowse).toHaveBeenLastCalledWith("ws-1", "c-1", {
    containerId: "id:projects",
  });
  expect(rowNames()).toEqual(["Q3", "plan.pdf"]);
  expect(currentCrumb()).toBe("Projects");
  expect(button("Dropbox", dialog())).toBeTruthy();
});

test("breadcrumb returns to parent", async () => {
  browseByContainer({
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

  // The parent appears as a crumb between the root and the current container.
  const crumbs = dialog().querySelector("nav")!;
  await click(button("Projects", crumbs));
  await flush(5);

  expect(selectionBrowse).toHaveBeenLastCalledWith("ws-1", "c-1", {
    containerId: "id:projects",
  });
  expect(currentCrumb()).toBe("Projects");
  expect(rowNames()).toEqual(["Q3", "plan.pdf"]);

  await click(button("Dropbox", crumbs));
  await flush(5);
  expect(selectionBrowse).toHaveBeenLastCalledWith("ws-1", "c-1", {});
  expect(currentCrumb()).toBe("Dropbox");
});

test("the search input caps input length at 200", async () => {
  browseByContainer({ root: rootPage });
  await open();

  const search = dialog().querySelector<HTMLInputElement>(
    'input[type="search"]',
  )!;
  expect(search.maxLength).toBe(200);
});

test("renders no search box when the spec has no search action", async () => {
  browseByContainer({ root: rootPage });
  await open({
    spec: { ...dropboxSpec, actions: { browse: "x.browse", describe: "x.describe" } },
  });

  expect(dialog().querySelector('input[type="search"]')).toBeNull();
});

test("search replaces the list and clearing restores it", async () => {
  browseByContainer({ root: rootPage });
  selectionSearch.mockResolvedValue({
    entries: [
      entry("id:report", "report.docx", {
        detail: "/Projects/Q3/report.docx",
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
  expect(selectionSearch).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTime(1));
  await flush(5);

  expect(selectionSearch).toHaveBeenCalledTimes(1);
  expect(selectionSearch).toHaveBeenCalledWith("ws-1", "c-1", { query: "rep" });
  expect(rowNames()).toEqual(["report.docx"]);
  expect(dialog().textContent).toContain("/Projects/Q3/report.docx");

  // Whitespace alone is not a query.
  await act(async () => typeInto(search, "   "));
  await act(async () => vi.advanceTimersByTime(300));
  await flush(5);

  expect(rowNames()).toEqual(["Projects", "readme.md"]);
  expect(selectionSearch).toHaveBeenCalledTimes(1);
  // The container listing is restored without fetching it again.
  expect(selectionBrowse).toHaveBeenCalledTimes(1);
});

test("selecting and unselecting files and folders updates the count", async () => {
  browseByContainer({ root: rootPage });
  const { onConfirm, onOpenChange } = await open({
    initialSelection: [{ id: "id:other", kind: "file" }],
  });

  expect(dialog().textContent).toContain("0 selected");
  expect(dialog().textContent).toContain("Folders sync up to 1,000 files in total");
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

  expect(onConfirm).toHaveBeenCalledWith([{ id: "id:projects", kind: "folder" }]);
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

test("an item already in the selection shows as added and cannot be picked again", async () => {
  browseByContainer({ root: rootPage });
  await open({ initialSelection: [{ id: "id:readme", kind: "file" }] });

  const box = checkbox("readme.md");
  expect(box.getAttribute("aria-checked")).toBe("true");
  expect(box.disabled).toBe(true);
  const row = dialog().querySelector('[data-selection-entry="readme.md"]')!;
  expect(row.getAttribute("title")).toBe("Already added");
  expect(row.textContent).toContain("Already added");
  expect(dialog().textContent).toContain("0 selected");
});

test("a non-selectable reason wins over 'already added'", async () => {
  browseByContainer({
    root: page({
      entries: [
        entry("id:zip", "archive.zip", {
          selectable: false,
          disabledReason: "unsupported",
        }),
      ],
    }),
  });
  // The id is already in the selection, yet the row shows why it cannot be
  // selected rather than "Already added" (the old priority order).
  await open({ initialSelection: [{ id: "id:zip", kind: "file" }] });

  const row = dialog().querySelector<HTMLElement>(
    '[data-selection-entry="archive.zip"]',
  )!;
  expect(row.getAttribute("title")).toBe("This file type cannot be indexed");
  expect(row.textContent).toContain("This file type cannot be indexed");
  expect(row.textContent).not.toContain("Already added");
});

test("an empty Dropbox folder keeps its own text, and a type without the key shows the generic text", async () => {
  const pages = {
    root: page({ entries: [folderEntry("id:f", "F")] }),
    "id:f": page({ container: container("id:f", "F", "/F"), entries: [] }),
  };
  browseByContainer(pages);
  await open();
  await click(button("F", dialog()));
  await flush(5);
  // Dropbox keeps its own empty-folder wording for an opened container.
  expect(dialog().textContent).toContain("This folder is empty.");
  await unmountAll();

  // A type that defines no per-type container text shows the generic text.
  browseByContainer(pages);
  await open({ connectorType: "x-tools", providerName: "X Tools" });
  await click(button("F", dialog()));
  await flush(5);
  expect(dialog().textContent).toContain("Nothing here.");
});

test("a failed confirm keeps the dialog open", async () => {
  browseByContainer({ root: rootPage });
  const { onOpenChange } = await open({ onConfirm: vi.fn(async () => false) });

  await click(checkbox("readme.md"));
  await click(button("Add", dialog()));
  await flush(5);

  expect(onOpenChange).not.toHaveBeenCalled();
  expect(dialog().textContent).toContain("1 selected");
});

test("an entry that is not expandable cannot be entered, and one that is not selectable shows its reason", async () => {
  browseByContainer({
    root: page({
      entries: [
        entry("id:zip", "archive.zip", {
          selectable: false,
          disabledReason: "unsupported",
        }),
        entry("id:doc", "report.docx"),
      ],
    }),
  });
  await open();

  // A file entry is not expandable: its label is a plain div, so the only
  // button in the row is the checkbox and there is no browse beyond the root.
  const row = dialog().querySelector<HTMLElement>(
    '[data-selection-entry="report.docx"]',
  )!;
  expect(row.querySelectorAll("button")).toHaveLength(1);
  expect(selectionBrowse).toHaveBeenCalledTimes(1);

  // A non-selectable entry shows its reason and cannot be ticked.
  const unsupported = dialog().querySelector<HTMLElement>(
    '[data-selection-entry="archive.zip"]',
  )!;
  expect(unsupported.getAttribute("title")).toBe("This file type cannot be indexed");
  expect(unsupported.textContent).toContain("This file type cannot be indexed");
  expect(unsupported.getAttribute("aria-disabled")).toBe("true");
  const box = checkbox("archive.zip");
  expect(box.disabled).toBe(true);
  await click(box);
  expect(box.getAttribute("aria-checked")).toBe("false");
  expect(dialog().textContent).toContain("0 selected");
});

test("a non-selectable entry with no known reason falls back to the generic text", async () => {
  browseByContainer({
    root: page({
      entries: [
        entry("id:x", "mystery", { selectable: false, disabledReason: null }),
      ],
    }),
  });
  await open();

  const row = dialog().querySelector<HTMLElement>(
    '[data-selection-entry="mystery"]',
  )!;
  expect(row.textContent).toContain("This item cannot be selected");
});

test("uses spec.maxItems for the limit", async () => {
  browseByContainer({
    root: page({
      entries: [
        entry("id:a", "a.pdf"),
        entry("id:b", "b.pdf"),
        entry("id:c", "c.pdf"),
      ],
    }),
  });
  const { onConfirm, onOpenChange } = await open({
    spec: { ...dropboxSpec, maxItems: 2 },
  });

  await click(checkbox("a.pdf"));
  await click(checkbox("b.pdf"));
  await click(checkbox("c.pdf"));
  await click(button("Add", dialog()));
  await flush(5);

  expect(toastError).toHaveBeenCalledWith(
    "You can select at most 2 items. Remove some before adding more.",
  );
  // The add is blocked: the picker neither confirms nor closes.
  expect(onConfirm).not.toHaveBeenCalled();
  expect(onOpenChange).not.toHaveBeenCalledWith(false);
});

test("Refresh reloads the current container and ignores a slower earlier response", async () => {
  // Root resolves immediately; opening folder A is deferred, then Refresh
  // resolves first with [x], and only afterwards does the first open resolve
  // with [y]. The stale first response must not replace [x].
  let resolveFirst: ((result: ConnectorSelectionBrowseResult) => void) | null =
    null;
  let call = 0;
  selectionBrowse.mockImplementation(
    async (_ws: string, _c: string, input: { containerId?: string | null }) => {
      if (input.containerId !== "id:a") {
        return page({ entries: [folderEntry("id:a", "A")] });
      }
      call += 1;
      if (call === 1) {
        return new Promise<ConnectorSelectionBrowseResult>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return page({
        container: container("id:a", "A", "/A"),
        entries: [entry("id:x", "x.pdf")],
      });
    },
  );
  await open();
  // Enter A (first request stays pending).
  await click(button("A", dialog()));
  await flush(5);

  // Refresh re-opens A; this second request resolves with [x].
  await click(
    dialog().querySelector<HTMLElement>('button[aria-label="Refresh"]')!,
  );
  await flush(5);
  expect(rowNames()).toEqual(["x.pdf"]);

  // The stale first response now arrives with [y]; the newer request wins.
  await act(async () => {
    resolveFirst?.(
      page({
        container: container("id:a", "A", "/A"),
        entries: [entry("id:y", "y.pdf")],
      }),
    );
  });
  await flush(5);
  expect(rowNames()).toEqual(["x.pdf"]);
});

test("shows the help link as a new-tab button and omits it when null", async () => {
  // Dropbox defines no help-link label, so even a present helpLink is omitted.
  browseByContainer({
    root: page({
      entries: [entry("id:readme", "readme.md")],
      helpLink: { code: "learnMore", url: "https://example.com/help" },
    }),
  });
  await open();
  expect(
    dialog().querySelector('a[href="https://example.com/help"]'),
  ).toBeNull();
  await unmountAll();

  // With a per-type label for the code, the link renders as a new-tab anchor.
  browseByContainer({
    root: page({
      entries: [entry("id:readme", "readme.md")],
      helpLink: { code: "learnMore", url: "https://example.com/help" },
    }),
  });
  await open(
    {},
    {
      messages: withSelectionMessages({
        byType: { dropbox: { helpLink: { learnMore: "Learn more" } } },
      }),
    },
  );
  const link = dialog().querySelector<HTMLAnchorElement>(
    'a[href="https://example.com/help"]',
  )!;
  expect(link.textContent).toContain("Learn more");
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toBe("noopener noreferrer");
});

test("an empty root shows the per-type emptyRoot text when the type defines one, else the generic text", async () => {
  browseByContainer({ root: page({ entries: [] }) });
  await open();
  expect(dialog().textContent).toContain("Nothing here.");
  await unmountAll();

  browseByContainer({ root: page({ entries: [] }) });
  await open(
    {},
    {
      messages: withSelectionMessages({
        byType: { dropbox: { browser: { emptyRoot: "Dropbox is empty." } } },
      }),
    },
  );
  expect(dialog().textContent).toContain("Dropbox is empty.");
});

test("an entry with an empty name shows the untitled fallback", async () => {
  browseByContainer({ root: page({ entries: [entry("id:blank", "")] }) });
  await open();

  const row = dialog().querySelector<HTMLElement>(
    '[data-selection-entry=""]',
  )!;
  expect(row.textContent).toContain("Untitled");
  expect(checkbox("Untitled")).toBeTruthy();
});

test("load more appends entries", async () => {
  selectionBrowse.mockImplementation(
    async (
      _ws: string,
      _c: string,
      input: { containerId?: string | null; cursor?: string },
    ) => {
      if (input.cursor === "page-2") {
        return page({ entries: [entry("id:b", "b.pdf")], hasMore: false });
      }
      if (input.containerId === "id:q3") {
        return page({
          container: container("id:q3", "Q3", "/Projects/Q3"),
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

  expect(selectionBrowse).toHaveBeenLastCalledWith("ws-1", "c-1", {
    cursor: "page-2",
  });
  expect(rowNames()).toEqual(["a.pdf", "b.pdf"]);
  // The continuation page carries no container; the first page's is kept.
  expect(currentCrumb()).toBe("Q3");
  expect(button("Projects", dialog().querySelector("nav")!)).toBeTruthy();
  expect(buttons("Load more", dialog())).toHaveLength(0);
});

test("reauth error shows the reconnect message", async () => {
  selectionBrowse.mockRejectedValue(
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
