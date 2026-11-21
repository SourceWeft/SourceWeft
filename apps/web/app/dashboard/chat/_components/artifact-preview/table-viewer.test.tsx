// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configureTableHost,
  readOnlyTableHost,
  TABLE_TRANSLATION_KEYS,
  TableArtifactView,
  TableHostProvider,
  tableArtifactUi,
  TableViewer,
  type TableHost,
} from "@sourceweft/builtin-tool-table/ui";
import { resolveArtifactPreview } from "@sourceweft/agent-tool-registry/ui";
import type { TableFreshness } from "@sourceweft/contracts/table";
import en from "@/messages/en.json";
import zhCN from "@/messages/zh-CN.json";
import zhTW from "@/messages/zh-TW.json";
import { button, buttons, flush, mount, mountWithIntl, unmountAll } from "@/test/react";
import { webTableHost } from "./table-host";
import {
  buildTable,
  COLUMN_IDS,
  tableFixtureEn,
  tableFixtureZh,
} from "./table-test-fixtures";

afterEach(async () => {
  await unmountAll();
  vi.restoreAllMocks();
  configureTableHost(null);
});

const version = {
  workspaceId: "workspace-1",
  artifactId: "artifact-1",
  artifactVersionId: "version-1",
};

type Call = { method: string; input: unknown };

/** An interactive host that answers from memory, shows keys with their values, and records calls. */
function recordingHost(overrides: Partial<TableHost> = {}) {
  const calls: Call[] = [];
  const keysAsked = new Set<string>();
  const record = (method: string, input: unknown) => calls.push({ method, input });
  const host: TableHost = {
    interactive: true,
    useTranslate: () => (key, values) => {
      keysAsked.add(key);
      return values && Object.keys(values).length > 0
        ? `${key} ${Object.entries(values)
            .map(([name, value]) => `${name}=${value}`)
            .join(" ")}`
        : key;
    },
    openSourceAtEvidence: (evidence, context) => record("openSourceAtEvidence", { evidence, context }),
    currentQuoteHash: async (evidence) => evidence.quoteHash,
    downloadFile: (name, mime, text) => record("downloadFile", { name, mime, text }),
    ...overrides,
  };
  return {
    host,
    keysAsked,
    callsTo: (method: string) => calls.filter((c) => c.method === method).map((c) => c.input),
  };
}

function withHost(host: TableHost, node: ReactNode) {
  return createElement(TableHostProvider, { host }, node);
}

function viewer(props: Partial<Parameters<typeof TableViewer>[0]> = {}) {
  return createElement(TableViewer, { content: tableFixtureEn, version, ...props });
}

function text() {
  return document.body.textContent ?? "";
}

function bodyRows() {
  return [...document.querySelectorAll("tbody tr")];
}

function titles() {
  return bodyRows().map((row) => row.querySelector("th")!.firstElementChild!.textContent);
}

function headerNames() {
  return [...document.querySelectorAll("thead th")].map((th) => th.textContent?.trim());
}

function sortBy(label: string) {
  const header = [...document.querySelectorAll<HTMLButtonElement>("thead th button")].find(
    (node) => node.textContent?.trim() === label,
  )!;
  return act(async () => header.click());
}

async function mountViewer(host: TableHost, props: Partial<Parameters<typeof TableViewer>[0]> = {}) {
  await mount(withHost(host, viewer(props)));
  await flush(3);
}

describe("TableViewer rows and columns", () => {
  it("renders one row per source with the source title first", async () => {
    await mountViewer(recordingHost().host);
    expect(titles()).toEqual(["Alpha Phone", "Beta Phone", "Gamma Phone"]);
    expect(headerNames()).toEqual(["table.source", "Price", "Launch date", "Warranty"]);
    for (const row of bodyRows()) {
      expect(row.children[0]!.tagName).toBe("TH");
      expect(row.children).toHaveLength(4);
    }
    expect(text()).toContain("table.summary sources=3 columns=3");
  });

  it("renders Chinese content the same way", async () => {
    await mountViewer(recordingHost().host, { content: tableFixtureZh });
    expect(titles()).toEqual(["甲手机", "乙手机", "丙手机"]);
    expect(headerNames()).toEqual(["table.source", "价格", "发布日期", "保修"]);
    expect(text()).toContain("一千二百元");
  });

  it("shows a failed row and a not-indexed row as one message across the answers", async () => {
    const content = buildTable("en", ["Price", "Launch date", "Warranty"], [
      { title: "Broken", status: "failed", cells: ["not_found", "not_found", "not_found"] },
      { title: "Pending", status: "skipped", cells: ["not_found", "not_found", "not_found"] },
    ]);
    await mountViewer(recordingHost().host, { content });
    const [failed, skipped] = bodyRows();
    expect(failed!.textContent).toContain("table.row.failed");
    expect(skipped!.textContent).toContain("table.row.notIndexed");
    expect(failed!.querySelectorAll("td")).toHaveLength(1);
    expect(failed!.querySelector("td")!.getAttribute("colspan")).toBe("3");
  });

  it("scrolls inside its own container with a sticky title column and header", async () => {
    await mountViewer(recordingHost().host);
    const region = document.querySelector<HTMLElement>('[role="region"]')!;
    expect(region.className).toContain("overflow-auto");
    expect(region.getAttribute("tabindex")).toBe("0");
    expect(region.contains(document.querySelector("table"))).toBe(true);
    expect(bodyRows()[0]!.querySelector("th")!.className).toContain("sticky");
    expect(bodyRows()[0]!.querySelector("th")!.className).toContain("left-0");
    expect(document.querySelector("thead th")!.className).toContain("sticky");
    // Nothing above the container may force the page wider than the screen.
    const root = document.querySelector<HTMLElement>("[data-table-viewer]")!;
    expect(root.className).toContain("min-w-0");
    expect(root.className).toContain("max-w-full");
  });
});

describe("TableViewer sorting", () => {
  it("orders a number column by its normalized value and keeps empty cells last in both directions", async () => {
    await mountViewer(recordingHost().host);
    expect(titles()).toEqual(["Alpha Phone", "Beta Phone", "Gamma Phone"]);

    await sortBy("Price");
    // 950 before 1,200 although "1,200 USD" sorts first as text; Gamma has no price.
    expect(titles()).toEqual(["Beta Phone", "Alpha Phone", "Gamma Phone"]);

    await sortBy("Price");
    expect(titles()).toEqual(["Alpha Phone", "Beta Phone", "Gamma Phone"]);
    expect(document.querySelector('thead th[aria-sort="descending"]')!.textContent).toContain("Price");

    await sortBy("Price");
    expect(titles()).toEqual(["Alpha Phone", "Beta Phone", "Gamma Phone"]);
    expect(document.querySelector('thead th[aria-sort="ascending"]')).toBeNull();
  });

  it("sorts dates by their ISO form and puts not_found and unverified cells after the values", async () => {
    await mountViewer(recordingHost().host);
    await sortBy("Launch date");
    expect(titles()).toEqual(["Gamma Phone", "Alpha Phone", "Beta Phone"]);
    await sortBy("Launch date");
    expect(titles()).toEqual(["Alpha Phone", "Gamma Phone", "Beta Phone"]);

    // Warranty: Beta's cell is unverified, so it is empty and stays last.
    await sortBy("Warranty");
    expect(titles()).toEqual(["Gamma Phone", "Alpha Phone", "Beta Phone"]);
    await sortBy("Warranty");
    expect(titles()).toEqual(["Alpha Phone", "Gamma Phone", "Beta Phone"]);
  });

  it("is stable: rows that tie keep the table's own order in both directions", async () => {
    const same = { found: "Same", quote: "Same." };
    const content = buildTable("en", ["Price", "Launch date", "Warranty"], [
      { title: "One", cells: ["not_found", "not_found", same] },
      { title: "Two", cells: ["not_found", "not_found", { found: "Aardvark", quote: "A." }] },
      { title: "Three", cells: ["not_found", "not_found", same] },
      { title: "Four", cells: ["not_found", "not_found", "not_found"] },
      { title: "Five", cells: ["not_found", "not_found", same] },
    ]);
    await mountViewer(recordingHost().host, { content });
    await sortBy("Warranty");
    expect(titles()).toEqual(["Two", "One", "Three", "Five", "Four"]);
    await sortBy("Warranty");
    expect(titles()).toEqual(["One", "Three", "Five", "Two", "Four"]);
  });

  it("sorts Chinese text and the source column", async () => {
    await mountViewer(recordingHost().host, { content: tableFixtureZh });
    await sortBy("价格");
    expect(titles()).toEqual(["乙手机", "甲手机", "丙手机"]);
    await sortBy("table.source");
    expect(titles()).toEqual(["甲手机", "乙手机", "丙手机"].sort((a, b) => a.localeCompare(b, "zh-CN")));
  });

  it("sorts headers by keyboard-operable buttons and says which column is sorted", async () => {
    await mountViewer(recordingHost().host);
    const headers = [...document.querySelectorAll("thead th")];
    for (const header of headers) {
      expect(header.querySelector("button")!.tabIndex).toBeGreaterThanOrEqual(0);
      expect(header.getAttribute("aria-sort")).toBe("none");
    }
    await sortBy("Price");
    expect(headers[1]!.getAttribute("aria-sort")).toBe("ascending");
    expect(headers[2]!.getAttribute("aria-sort")).toBe("none");
  });
});

describe("TableViewer cells", () => {
  it("opens a found cell's quote on click and offers to open the source", async () => {
    const { host, callsTo } = recordingHost();
    await mountViewer(host);
    expect(text()).not.toContain("The Alpha Phone costs 1,200 USD at launch.");

    const cell = button("1,200 USD");
    expect(cell.getAttribute("aria-expanded")).toBe("false");
    await act(async () => cell.click());
    await flush(3);
    expect(cell.getAttribute("aria-expanded")).toBe("true");
    expect(text()).toContain("The Alpha Phone costs 1,200 USD at launch.");
    expect(text()).toContain("Specifications > Details");

    await act(async () => button("table.evidence.openSource").click());
    expect(callsTo("openSourceAtEvidence")).toEqual([
      {
        evidence: expect.objectContaining({ chunkId: "chunk-1", sourceId: "source-1" }),
        context: { workspaceId: "workspace-1", artifactId: "artifact-1" },
      },
    ]);

    await act(async () => cell.click());
    expect(text()).not.toContain("The Alpha Phone costs 1,200 USD at launch.");
  });

  it("shows the not-mentioned label for a not_found cell, with nothing to open", async () => {
    await mountViewer(recordingHost().host);
    const cell = document.querySelectorAll('tbody tr')[1]!.querySelector('[data-cell-status="not_found"]')!;
    expect(cell.textContent).toBe("table.cell.notFound");
    expect(cell.querySelector("button")).toBeNull();
    expect(cell.className).toContain("text-muted-foreground");
  });

  it("shows the unverified label and never a value", async () => {
    const { host } = recordingHost();
    await mountViewer(host);
    const cell = document.querySelector('[data-cell-status="unverified"]')!;
    expect(cell.textContent).toContain("table.cell.unverified");
    expect(cell.textContent).toContain("table.cell.unverifiedHint");
    expect(cell.querySelector("button")).toBeNull();
    // Beta Phone's warranty is the unverified one: nothing of a guess is on the row.
    expect(bodyRows()[1]!.textContent).not.toMatch(/year/i);
  });

  it("makes cells with evidence native buttons, so Tab focuses them and Enter or Space opens them", async () => {
    await mountViewer(recordingHost().host);
    const found = [...document.querySelectorAll<HTMLButtonElement>('[data-cell-status="found"] button')];
    expect(found).toHaveLength(6);
    for (const control of found) {
      expect(control.tagName).toBe("BUTTON");
      expect(control.type).toBe("button");
      expect(control.tabIndex).toBe(0);
    }
  });
});

describe("TableViewer freshness", () => {
  const stale: TableFreshness = {
    state: "stale",
    changedSourceIds: ["source-2"],
    deletedSourceIds: [],
  };

  it("marks a stale row and the banner offers regeneration", async () => {
    const onRegenerate = vi.fn();
    const { host } = recordingHost({ onRegenerate });
    await mountViewer(host, { freshness: stale });

    const rows = bodyRows();
    expect(rows[1]!.getAttribute("data-stale")).toBe("stale");
    expect(rows[1]!.textContent).toContain("table.row.stale");
    expect(rows[0]!.getAttribute("data-stale")).toBeNull();
    expect(text()).toContain("table.stale.message");

    // The toolbar and the banner both carry a regenerate control.
    expect(buttons("table.stale.regenerate")).toHaveLength(1);
    await act(async () => button("table.stale.regenerate").click());
    expect(onRegenerate).toHaveBeenCalledWith(version);
  });

  it("marks a deleted source and says the table is still usable", async () => {
    const { host } = recordingHost({ onRegenerate: vi.fn() });
    await mountViewer(host, {
      freshness: { state: "source_deleted", changedSourceIds: [], deletedSourceIds: ["source-3"] },
    });
    expect(bodyRows()[2]!.getAttribute("data-stale")).toBe("source_deleted");
    expect(bodyRows()[2]!.textContent).toContain("table.row.sourceDeleted");
    expect(text()).toContain("table.stale.sourceDeleted");
    expect(buttons("table.stale.regenerate")).toHaveLength(0);
  });

  it("shows no banner and no marks while the table is fresh", async () => {
    await mountViewer(recordingHost({ onRegenerate: vi.fn() }).host, {
      freshness: { state: "fresh", changedSourceIds: [], deletedSourceIds: [] },
    });
    expect(text()).not.toContain("table.stale");
    expect(document.querySelector("[data-stale]")).toBeNull();
  });

  it("offers a regenerate control in the toolbar only when the host can regenerate", async () => {
    const onRegenerate = vi.fn();
    await mountViewer(recordingHost({ onRegenerate }).host);
    await act(async () => button("table.toolbar.regenerate").click());
    expect(onRegenerate).toHaveBeenCalledWith(version);

    await unmountAll();
    await mountViewer(recordingHost().host);
    expect(buttons("table.toolbar.regenerate")).toHaveLength(0);
  });
});

describe("TableViewer share surface", () => {
  it("shows no quote text and no regenerate control", async () => {
    const onRegenerate = vi.fn();
    const { host, callsTo } = recordingHost({ onRegenerate });
    await mountViewer(host, {
      interactive: false,
      freshness: { state: "stale", changedSourceIds: ["source-1"], deletedSourceIds: [] },
    });

    // Values are there, as plain text with nothing to open.
    expect(text()).toContain("1,200 USD");
    expect(document.querySelectorAll('[data-cell-status="found"] button')).toHaveLength(0);
    expect(text()).not.toContain("The Alpha Phone costs 1,200 USD at launch.");
    expect(text()).not.toContain("table.evidence");
    expect(buttons("table.toolbar.regenerate")).toHaveLength(0);
    expect(buttons("table.stale.regenerate")).toHaveLength(0);
    expect(text()).not.toContain("table.stale.message");
    expect(document.querySelector("[data-stale]")).toBeNull();
    expect(callsTo("openSourceAtEvidence")).toEqual([]);
  });

  it("opens a public payload whose evidence was removed, and cannot show a quote left in by mistake", async () => {
    const stripped = JSON.parse(JSON.stringify(tableFixtureEn));
    for (const row of stripped.rows) {
      for (const cell of Object.values<Record<string, unknown>>(row.cells)) {
        if (cell.status === "found") {
          cell.evidence = (cell.evidence as Record<string, unknown>[]).map((entry) => {
            const rest = { ...entry };
            delete rest.quote;
            delete rest.startChar;
            delete rest.endChar;
            return rest;
          });
        }
      }
    }
    const artifact = {
      id: "artifact-1",
      workspaceId: "workspace-1",
      artifactType: "table",
      status: "ready",
      errorMessage: null,
    };
    await mount(
      withHost(
        recordingHost().host,
        createElement(TableArtifactView, { artifact, payload: stripped, interactive: false }),
      ),
    );
    await flush(3);
    expect(titles()).toEqual(["Alpha Phone", "Beta Phone", "Gamma Phone"]);
    expect(text()).toContain("1,200 USD");

    await unmountAll();
    await mount(
      withHost(
        recordingHost().host,
        createElement(TableArtifactView, { artifact, payload: tableFixtureEn as never, interactive: false }),
      ),
    );
    await flush(3);
    expect(text()).toContain("1,200 USD");
    expect(text()).not.toContain("costs 1,200 USD at launch");
    expect(document.body.innerHTML).not.toContain("costs 1,200 USD at launch");
  });
});

describe("TableViewer column visibility", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  /** The toolbar button also counts hidden columns, so its text is not just the label. */
  function columnsButton() {
    return [...document.querySelectorAll("button")].find((node) =>
      node.textContent?.startsWith("table.columns.button"),
    )!;
  }

  async function hideColumn(label: string) {
    await act(async () => columnsButton().click());
    const box = [...document.querySelectorAll<HTMLLabelElement>("fieldset label")]
      .find((node) => node.textContent === label)!
      .querySelector("input")!;
    await act(async () => box.click());
  }

  it("hides a column and remembers the choice by column id", async () => {
    await mountViewer(recordingHost().host);
    await hideColumn("Launch date");
    expect(headerNames()).toEqual(["table.source", "Price", "Warranty"]);
    expect(bodyRows()[0]!.children).toHaveLength(3);
    expect(JSON.parse(window.localStorage.getItem("sourceweft:table:hidden-columns")!)).toEqual([
      COLUMN_IDS.launched,
    ]);

    // A new view of the same table starts with the column hidden...
    await unmountAll();
    await mountViewer(recordingHost().host);
    expect(headerNames()).toEqual(["table.source", "Price", "Warranty"]);

    // ...even when the column has been renamed, since the id is what is kept.
    await unmountAll();
    const renamed = { ...tableFixtureEn, columns: tableFixtureEn.columns.map((column) =>
      column.id === COLUMN_IDS.launched ? { ...column, name: "Released" } : column) };
    await mountViewer(recordingHost().host, { content: renamed });
    expect(headerNames()).toEqual(["table.source", "Price", "Warranty"]);

    await act(async () => columnsButton().click());
    await act(async () => button("table.columns.showAll").click());
    expect(headerNames()).toEqual(["table.source", "Price", "Released", "Warranty"]);
    expect(JSON.parse(window.localStorage.getItem("sourceweft:table:hidden-columns")!)).toEqual([]);
  });

  it("brings every column back when storage is unavailable, and still hides for this view", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    await mountViewer(recordingHost().host);
    expect(headerNames()).toEqual(["table.source", "Price", "Launch date", "Warranty"]);

    await hideColumn("Price");
    expect(headerNames()).toEqual(["table.source", "Launch date", "Warranty"]);
  });

  it("ignores stored data it cannot read", async () => {
    window.localStorage.setItem("sourceweft:table:hidden-columns", "{not json");
    await mountViewer(recordingHost().host);
    expect(headerNames()).toEqual(["table.source", "Price", "Launch date", "Warranty"]);
  });
});

describe("TableArtifactView", () => {
  const artifact = (overrides: Record<string, unknown> = {}) => ({
    id: "artifact-1",
    workspaceId: "workspace-1",
    artifactType: "table",
    status: "ready",
    errorMessage: null,
    artifactVersionId: "version-1",
    ...overrides,
  });

  function view(overrides: Record<string, unknown> = {}, payload: unknown = tableFixtureEn) {
    return createElement(TableArtifactView, {
      artifact: artifact(overrides),
      payload: payload as Record<string, unknown>,
    });
  }

  it("shows progress while generating", async () => {
    await mount(withHost(recordingHost().host, view({ status: "running" }, { table: { progress: { stage: "fill", done: 7, total: 20 } } })));
    expect(text()).toContain("table.status.generating completed=7 total=20");
    await unmountAll();
    await mount(withHost(recordingHost().host, view({ status: "pending" }, {})));
    expect(text()).toContain("table.status.queued");
  });

  it("words a failure by its code and offers to retry only when the host can", async () => {
    const onRegenerate = vi.fn();
    await mount(withHost(recordingHost({ onRegenerate }).host, view({ status: "failed", errorCode: "INPUT_TOO_LARGE" })));
    expect(text()).toContain("table.error.code.INPUT_TOO_LARGE");
    await act(async () => button("table.error.retry").click());
    expect(onRegenerate).toHaveBeenCalledWith(version);

    await unmountAll();
    await mount(withHost(recordingHost().host, view({ status: "failed", errorCode: "SOMETHING_NEW" })));
    expect(text()).toContain("table.error.code.UNKNOWN");
    expect(buttons("table.error.retry")).toHaveLength(0);
  });

  it("keeps the regenerate buttons busy while the host is still answering", async () => {
    let answer: () => void = () => {};
    const onRegenerate = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          answer = resolve;
        }),
    );
    const getFreshness = vi.fn(async () => ({
      state: "stale" as const,
      changedSourceIds: ["source-1"],
      deletedSourceIds: [],
    }));
    await mount(withHost(recordingHost({ onRegenerate, getFreshness }).host, view()));
    await flush(5);
    const toolbar = button("table.toolbar.regenerate");
    const banner = button("table.stale.regenerate");
    await act(async () => toolbar.click());
    expect(toolbar.disabled).toBe(true);
    expect(banner.disabled).toBe(false);
    await act(async () => answer());
    await flush(2);
    expect(toolbar.disabled).toBe(false);

    await act(async () => banner.click());
    expect(banner.disabled).toBe(true);
    await act(async () => answer());
    await flush(2);
    expect(banner.disabled).toBe(false);

    await unmountAll();
    await mount(withHost(recordingHost({ onRegenerate }).host, view({ status: "failed", errorCode: "MODEL_UNAVAILABLE" })));
    const retry = button("table.error.retry");
    await act(async () => retry.click());
    expect(retry.disabled).toBe(true);
    await act(async () => answer());
    await flush(2);
    expect(retry.disabled).toBe(false);
  });

  it("shows a message instead of crashing on an invalid payload", async () => {
    await mount(withHost(recordingHost().host, view({}, { kind: "table" })));
    expect(text()).toContain("table.error.cannotDisplay");
  });

  it("asks the host whether the sources changed and marks the stale rows", async () => {
    const getFreshness = vi.fn(async () => ({
      state: "stale" as const,
      changedSourceIds: ["source-1"],
      deletedSourceIds: [],
    }));
    const { host } = recordingHost({ getFreshness, onRegenerate: vi.fn() });
    await mount(withHost(host, view()));
    await flush(5);
    expect(getFreshness).toHaveBeenCalledWith(version);
    expect(bodyRows()[0]!.getAttribute("data-stale")).toBe("stale");
    expect(text()).toContain("table.stale.message");
  });

  it("never asks about freshness on the share surface", async () => {
    const getFreshness = vi.fn(async () => ({ state: "stale" as const, changedSourceIds: [], deletedSourceIds: [] }));
    await mount(
      withHost(
        recordingHost({ getFreshness }).host,
        createElement(TableArtifactView, {
          artifact: artifact(),
          payload: tableFixtureEn as never,
          interactive: false,
        }),
      ),
    );
    await flush(5);
    expect(getFreshness).not.toHaveBeenCalled();
  });

  it("falls back to the read-only host: values and sorting work, nothing regenerates", async () => {
    configureTableHost(null);
    await mount(view());
    await flush(3);
    expect(titles()).toEqual(["Alpha Phone", "Beta Phone", "Gamma Phone"]);
    expect(buttons("table.toolbar.regenerate")).toHaveLength(0);
    expect(readOnlyTableHost.interactive).toBe(false);
  });
});

describe("table artifact registration", () => {
  it("is the preview owner of the table artifact type", () => {
    expect(tableArtifactUi.id).toBe("table");
    expect(tableArtifactUi.artifactTypes).toEqual(["table"]);
    const preview = resolveArtifactPreview({
      artifact: { id: "a", workspaceId: "w", artifactType: "table", status: "ready", errorMessage: null },
      downloadUrl: null,
      layout: "panel",
      pageUrl: null,
      payload: tableFixtureEn as never,
      proxyFileUrl: null,
      title: "Phones",
    });
    expect(preview?.id).toBe("table");
    expect(preview?.blocksDefaultDownload).toBe(true);
  });

  it("renders the share surface without quotes", async () => {
    const preview = resolveArtifactPreview({
      artifact: { id: "a", workspaceId: "w", artifactType: "table", status: "ready", errorMessage: null },
      downloadUrl: null,
      layout: "page",
      pageUrl: null,
      payload: tableFixtureEn as never,
      proxyFileUrl: null,
      surface: "share",
      title: "Phones",
    });
    await mount(withHost(recordingHost({ onRegenerate: vi.fn() }).host, preview!.content));
    await flush(3);
    expect(document.querySelectorAll('[data-cell-status="found"] button')).toHaveLength(0);
    expect(buttons("table.toolbar.regenerate")).toHaveLength(0);
  });
});

describe("table translations", () => {
  const catalogs = { en, "zh-CN": zhCN, "zh-TW": zhTW } as const;

  function lookup(catalog: unknown, key: string) {
    return key.split(".").reduce<unknown>(
      (node, part) => (node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined),
      catalog,
    );
  }

  function placeholders(message: string) {
    return [...message.matchAll(/\{(\w+)[,}]/g)].map((match) => match[1]).sort();
  }

  it.each(Object.entries(catalogs))("%s has every key the viewer can ask for, with the same placeholders", (_locale, catalog) => {
    for (const key of TABLE_TRANSLATION_KEYS) {
      const message = lookup(catalog, key);
      expect(typeof message, key).toBe("string");
      expect(placeholders(message as string), key).toEqual(placeholders(lookup(en, key) as string));
    }
  });

  it("asks only for keys that are listed", async () => {
    const { host, keysAsked } = recordingHost({
      onRegenerate: vi.fn(),
      getFreshness: async () => ({ state: "stale", changedSourceIds: ["source-1"], deletedSourceIds: [] }),
    });
    const content = buildTable("en", ["Price", "Launch date", "Warranty"], [
      { title: "Broken", status: "failed", cells: ["not_found", "not_found", "not_found"] },
      { title: "Pending", status: "skipped", cells: ["not_found", "not_found", "not_found"] },
    ]);
    const artifact = { id: "a", workspaceId: "w", artifactType: "table", status: "ready", errorMessage: null };
    for (const payload of [tableFixtureEn, content]) {
      await mount(withHost(host, createElement(TableArtifactView, { artifact, payload: payload as never })));
      await flush(5);
      await act(async () => button("table.columns.button").click());
      await act(async () => button("1,200 USD")?.click());
      await flush(3);
      await unmountAll();
    }
    for (const status of ["pending", "running", "failed"]) {
      await mount(withHost(host, createElement(TableArtifactView, { artifact: { ...artifact, status }, payload: {} })));
      await unmountAll();
    }
    await mount(withHost(host, createElement(TableArtifactView, { artifact, payload: {} })));
    await mount(withHost(host, viewer({ content: { ...tableFixtureEn, rows: [] } })));
    const listed = new Set<string>(TABLE_TRANSLATION_KEYS);
    expect([...keysAsked].filter((key) => !listed.has(key))).toEqual([]);
    expect(keysAsked.size).toBeGreaterThan(15);
  });

  it("the web host shows the English catalog's wording for the cell states", async () => {
    await mountWithIntl(withHost(webTableHost, viewer()));
    await flush(3);
    expect(text()).toContain("Not mentioned");
    expect(text()).toContain("Could not be verified");
    expect(text()).toContain("3 sources · 3 columns");
    expect(button("Columns")).toBeDefined();
  });

  it("the web host speaks Simplified and Traditional Chinese", async () => {
    await mountWithIntl(withHost(webTableHost, viewer({ content: tableFixtureZh })), {
      locale: "zh-CN",
      messages: zhCN as never,
    });
    await flush(3);
    expect(text()).toContain("来源未提及");
    expect(text()).toContain("无法核实");
    expect(text()).toContain("3 个来源 · 3 列");
    await unmountAll();

    await mountWithIntl(withHost(webTableHost, viewer({ content: tableFixtureZh })), {
      locale: "zh-TW",
      messages: zhTW as never,
    });
    await flush(3);
    expect(text()).toContain("來源未提及");
    expect(text()).toContain("無法核實");
    expect(text()).toContain("3 個來源 · 3 欄");
  });

  it("the web host renders the evidence popover in the table's own wording", async () => {
    await mountWithIntl(withHost(webTableHost, viewer()));
    await act(async () => button("1,200 USD").click());
    await flush(3);
    expect(text()).toContain("Hide source quote");
    expect(text()).toContain("Open in source");
    expect(text()).not.toContain("study.evidence");
  });
});
