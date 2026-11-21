// @vitest-environment jsdom
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { HttpClientError } from "@sourceweft/sdk";
import type { TableColumnInput } from "@sourceweft/contracts/table";

const sdk = vi.hoisted(() => ({
  contentClient: {
    suggestTableColumns: vi.fn(),
    estimateTable: vi.fn(),
    generateTable: vi.fn(),
    regenerateTable: vi.fn(),
    listSourceMentions: vi.fn(),
    getSource: vi.fn(),
  },
}));
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));
vi.mock("../../../../../lib/sdk", () => sdk);

import { button, flush, mountWithIntl, typeInto, unmountAll, withIntl } from "@/test/react";
import { TableGenerateDialog } from "./table-generate-dialog";

const sources = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `source-${index + 1}`,
    title: `Source ${index + 1}`,
  }));

const columns = (count: number): TableColumnInput[] =>
  Array.from({ length: count }, (_, index) => ({
    name: `Column ${index + 1}`,
    type: "text",
  }));

function estimate(overrides: Record<string, unknown> = {}) {
  return {
    sources: 2,
    skippedSources: 0,
    columns: 1,
    cells: 2,
    calls: 2,
    inputTokensEstimate: 1200,
    exceedsLimit: false,
    ...overrides,
  };
}

const onQueued = vi.fn();
const onOpenChange = vi.fn();

async function renderDialog(props: Partial<Parameters<typeof TableGenerateDialog>[0]> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await mountWithIntl(
    <QueryClientProvider client={client}>
      <TableGenerateDialog
        open
        onOpenChange={onOpenChange}
        onQueued={onQueued}
        sources={sources(2)}
        target={{ kind: "generate", threadId: "thread-1" }}
        workspaceId="workspace-1"
        {...props}
      />
    </QueryClientProvider>,
  );
  await flush(3);
}

/** Lets the debounced estimate fire and its answer land. */
async function settleEstimate() {
  await act(async () => {
    vi.advanceTimersByTime(500);
  });
  await flush(5);
}

function nameInputs() {
  return [...document.querySelectorAll<HTMLInputElement>('input[name="table-column-name"]')];
}

function submitButton() {
  return button("Generate table");
}

function text() {
  return document.body.textContent ?? "";
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  sdk.contentClient.estimateTable.mockResolvedValue(estimate());
  sdk.contentClient.listSourceMentions.mockResolvedValue({
    items: [
      { id: "source-1", title: "Source 1" },
      { id: "source-new", title: "New source" },
    ],
    nextCursor: null,
  });
  sdk.contentClient.generateTable.mockResolvedValue({
    artifactId: "artifact-9",
    versionNo: 1,
    status: "pending",
    visibility: "private",
    reused: false,
  });
});

afterEach(async () => {
  await unmountAll();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("TableGenerateDialog", () => {
  test("the dialog cannot be submitted with zero columns or with an empty column name", async () => {
    await renderDialog();
    expect(nameInputs()).toHaveLength(1);
    expect(submitButton().disabled).toBe(true);
    // Nothing is pointed out before the person edits a column.
    expect(text()).not.toContain("Every column needs a name.");
    expect(text()).not.toContain("Estimating the size");
    expect(nameInputs()[0]!.getAttribute("aria-invalid")).toBeNull();

    typeInto(nameInputs()[0]!, "Pri");
    typeInto(nameInputs()[0]!, "");
    await flush(2);
    expect(submitButton().disabled).toBe(true);
    expect(text()).toContain("Every column needs a name.");
    expect(nameInputs()[0]!.getAttribute("aria-invalid")).toBe("true");

    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="Remove column 1"]')!.click(),
    );
    expect(nameInputs()).toHaveLength(0);
    expect(submitButton().disabled).toBe(true);
    expect(text()).toContain("Add at least one column.");

    await act(async () => button("Add column").click());
    typeInto(nameInputs()[0]!, "   ");
    await settleEstimate();
    expect(submitButton().disabled).toBe(true);
    expect(sdk.contentClient.estimateTable).not.toHaveBeenCalled();

    typeInto(nameInputs()[0]!, "Price");
    await settleEstimate();
    expect(submitButton().disabled).toBe(false);
    await act(async () => submitButton().click());
    await flush(5);
    expect(sdk.contentClient.generateTable).toHaveBeenCalledWith("workspace-1", {
      threadId: "thread-1",
      sourceIds: ["source-1", "source-2"],
      columns: [{ name: "Price", type: "text" }],
    });
    expect(toasts.success).toHaveBeenCalled();
    expect(onQueued).toHaveBeenCalledWith({
      artifactId: "artifact-9",
      versionNo: 1,
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test("suggesting columns fills the editor and keeps columns the user already typed", async () => {
    sdk.contentClient.suggestTableColumns.mockResolvedValue({
      columns: [
        { name: "price", type: "number" },
        { name: "Launch date", type: "date" },
        { name: "Warranty", description: "Length of cover", type: "text" },
      ],
    });
    await renderDialog();
    typeInto(nameInputs()[0]!, "Price");
    typeInto(
      document.querySelector<HTMLTextAreaElement>("#table-instruction")!,
      " Compare phones ",
    );
    await act(async () => button("Suggest columns").click());
    await flush(5);

    expect(sdk.contentClient.suggestTableColumns).toHaveBeenCalledWith("workspace-1", {
      sourceIds: ["source-1", "source-2"],
      instruction: "Compare phones",
    });
    expect(nameInputs().map((input) => input.value)).toEqual(["Price", "Launch date", "Warranty"]);
    expect(
      [
        ...document.querySelectorAll<HTMLInputElement>('input[name="table-column-description"]'),
      ].map((input) => input.value),
    ).toEqual(["", "", "Length of cover"]);
  });

  test("a 13th column cannot be added; 45 sources with 9 columns shows the 400-cell limit message", async () => {
    await renderDialog({ initialColumns: columns(12) });
    expect(nameInputs()).toHaveLength(12);
    expect(button("Add column").disabled).toBe(true);
    expect(text()).toContain("A table has at most 12 columns.");
    await unmountAll();

    await renderDialog({ sources: sources(45), initialColumns: columns(9) });
    await settleEstimate();
    expect(text()).toContain(
      "45 sources × 9 columns is 405 cells; a table holds at most 400. Use fewer sources or columns.",
    );
    expect(submitButton().disabled).toBe(true);
    expect(sdk.contentClient.estimateTable).not.toHaveBeenCalled();
  });

  test("the estimate shows source count and blocks submission when the input exceeds the limit", async () => {
    sdk.contentClient.estimateTable.mockResolvedValue(
      estimate({ sources: 3, skippedSources: 1, cells: 2, exceedsLimit: true }),
    );
    await renderDialog({ sources: sources(3), initialColumns: columns(1) });
    await settleEstimate();

    expect(sdk.contentClient.estimateTable).toHaveBeenCalledWith("workspace-1", {
      threadId: "thread-1",
      sourceIds: ["source-1", "source-2", "source-3"],
      columns: [{ name: "Column 1", type: "text" }],
    });
    expect(text()).toContain("3 sources · 2 cells to fill");
    expect(text()).toContain("1 source is not indexed yet and will be skipped.");
    expect(text()).toContain("The selected sources are too large for one table.");
    expect(submitButton().disabled).toBe(true);
  });

  test("a failed request is worded by its error code", async () => {
    sdk.contentClient.generateTable.mockRejectedValue(
      new HttpClientError({
        message: "Payment required",
        status: 402,
        statusText: "Payment Required",
        code: "INSUFFICIENT_CREDITS",
      }),
    );
    await renderDialog({ initialColumns: columns(1) });
    await settleEstimate();
    await act(async () => submitButton().click());
    await flush(5);
    expect(toasts.error).toHaveBeenCalledWith("Not enough credits to generate this table.");
    expect(onQueued).not.toHaveBeenCalled();

    sdk.contentClient.generateTable.mockRejectedValue(
      new HttpClientError({
        message: "Busy",
        status: 429,
        statusText: "Too Many Requests",
        code: "TABLE_TOO_MANY_RUNNING",
      }),
    );
    await act(async () => submitButton().click());
    await flush(5);
    expect(toasts.error).toHaveBeenLastCalledWith(
      "Too many tables and study sets are generating at once. Wait for one to finish.",
    );
  });

  test("regenerating sends the sources after one is removed and another added", async () => {
    sdk.contentClient.regenerateTable.mockResolvedValue({
      artifactId: "artifact-9",
      versionNo: 2,
      status: "pending",
    });
    await renderDialog({
      initialColumns: columns(1),
      target: {
        kind: "regenerate",
        threadId: "thread-1",
        artifactId: "artifact-9",
      },
    });
    expect(text()).toContain("2 sources");
    expect(text()).toContain("Source 1");
    expect(text()).toContain("Source 2");
    // The titles the dialog opened with need no lookup.
    expect(sdk.contentClient.getSource).not.toHaveBeenCalled();

    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="2 sources: Source 2 ×"]')!.click(),
    );
    expect(text()).toContain("1 source");
    await act(async () => button("Add source").click());
    await flush(5);
    await act(async () =>
      [...document.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')]
        .find((option) => option.textContent?.includes("New source"))!
        .click(),
    );
    expect(text()).toContain("2 sources");
    await settleEstimate();
    await act(async () => button("Regenerate").click());
    await flush(5);
    expect(sdk.contentClient.regenerateTable).toHaveBeenCalledWith("workspace-1", "artifact-9", {
      sourceIds: ["source-1", "source-new"],
      columns: [{ name: "Column 1", type: "text" }],
      instruction: "",
    });
  });

  test("with every source removed the dialog says so and cannot be submitted", async () => {
    await renderDialog({ initialColumns: columns(1) });
    for (const title of ["Source 1", "Source 2"]) {
      await act(async () =>
        document.querySelector<HTMLButtonElement>(`[aria-label$=": ${title} ×"]`)!.click(),
      );
    }
    await settleEstimate();
    expect(text()).toContain("Add at least one source.");
    expect(submitButton().disabled).toBe(true);
    expect(button("Suggest columns").disabled).toBe(true);
  });

  test("a re-render with fresh props while open keeps the person's edits", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const element = () => (
      <QueryClientProvider client={client}>
        <TableGenerateDialog
          open
          onOpenChange={onOpenChange}
          sources={sources(2)}
          target={{ kind: "generate", threadId: "thread-1" }}
          workspaceId="workspace-1"
        />
      </QueryClientProvider>
    );
    const handle = await mountWithIntl(element());
    typeInto(nameInputs()[0]!, "Price");
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label$=": Source 2 ×"]')!.click(),
    );
    // The hub re-renders with a new (equal) sources array, as a refresh does.
    await handle.render(withIntl(element()));
    await flush(2);
    expect(nameInputs()[0]!.value).toBe("Price");
    expect(text()).toContain("1 source");
  });
});
