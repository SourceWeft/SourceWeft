// @vitest-environment jsdom
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  contentClient: {
    listSourceMentions: vi.fn(async () => ({ items: [], nextCursor: null })),
    getSource: vi.fn(),
    getArtifact: vi.fn(),
    estimateTable: vi.fn(),
    regenerateTable: vi.fn(),
    getTableFreshness: vi.fn(),
    suggestTableColumns: vi.fn(),
    generateTable: vi.fn(),
  },
}));
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));
vi.mock("../../../../../lib/sdk", () => sdk);

import { button, flush, mountWithIntl, typeInto, unmountAll } from "@/test/react";
import { webTableHost } from "../artifact-preview/table-host";
import { COLUMN_IDS, tableFixtureEn } from "../artifact-preview/table-test-fixtures";
import { TableRegenerateDialogHost } from "./table-regenerate";

function mountHost() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return mountWithIntl(
    <QueryClientProvider client={client}>
      <TableRegenerateDialogHost />
    </QueryClientProvider>,
  );
}

const version = {
  workspaceId: "workspace-1",
  artifactId: "artifact-1",
  artifactVersionId: "version-1",
};

function storedArtifact(overrides: Record<string, unknown> = {}) {
  return {
    artifact: {
      id: "artifact-1",
      workspaceId: "workspace-1",
      threadId: "thread-1",
      artifactType: "table",
      status: "ready",
      payloadJson: tableFixtureEn,
      ...overrides,
    },
  };
}

function nameInputs() {
  return [...document.querySelectorAll<HTMLInputElement>('input[name="table-column-name"]')];
}

function text() {
  return document.body.textContent ?? "";
}

async function requestRegenerate() {
  await act(async () => webTableHost.onRegenerate!(version));
  await flush(8);
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  sdk.contentClient.getArtifact.mockResolvedValue(storedArtifact());
  sdk.contentClient.estimateTable.mockResolvedValue({
    sources: 3,
    skippedSources: 0,
    columns: 4,
    cells: 12,
    calls: 3,
    inputTokensEstimate: 5000,
    exceedsLimit: false,
  });
  sdk.contentClient.regenerateTable.mockResolvedValue({
    artifactId: "artifact-1",
    versionNo: 2,
    status: "pending",
  });
});

afterEach(async () => {
  await unmountAll();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("regenerating a table", () => {
  test("regenerate opens the dialog pre-filled from the recipe and sends column ids back", async () => {
    await mountHost();
    await requestRegenerate();

    expect(sdk.contentClient.getArtifact).toHaveBeenCalledWith("workspace-1", "artifact-1");
    expect(text()).toContain("Adjust and regenerate");
    expect(text()).toContain("Alpha Phone");
    expect(nameInputs().map((input) => input.value)).toEqual(["Price", "Launch date", "Warranty"]);

    await act(async () => button("Add column").click());
    typeInto(nameInputs()[3]!, "Battery");
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    await flush(5);
    expect(sdk.contentClient.estimateTable).toHaveBeenLastCalledWith(
      "workspace-1",
      expect.objectContaining({ threadId: "thread-1" }),
    );
    // The estimate counts every cell; a regeneration reuses the unchanged ones.
    expect(text()).toContain("3 sources · 4 columns; unchanged cells are reused");
    expect(text()).not.toContain("cells to fill");

    await act(async () => button("Regenerate").click());
    await flush(5);
    expect(sdk.contentClient.regenerateTable).toHaveBeenCalledWith("workspace-1", "artifact-1", {
      sourceIds: ["source-1", "source-2", "source-3"],
      columns: [
        { id: COLUMN_IDS.price, name: "Price", type: "number" },
        { id: COLUMN_IDS.launched, name: "Launch date", type: "date" },
        { id: COLUMN_IDS.warranty, name: "Warranty", type: "text" },
        { name: "Battery", type: "text" },
      ],
      instruction: "",
    });
    expect(toasts.success).toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  test("the request settles once the dialog is open, so the viewer can show it is busy", async () => {
    let finishLoading: (value: unknown) => void = () => {};
    sdk.contentClient.getArtifact.mockReturnValue(
      new Promise((resolve) => {
        finishLoading = resolve;
      }),
    );
    await mountHost();
    let settled = false;
    await act(async () => {
      void Promise.resolve(webTableHost.onRegenerate!(version)).then(() => {
        settled = true;
      });
    });
    await flush(5);
    expect(settled).toBe(false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    await act(async () => finishLoading(storedArtifact()));
    await flush(5);
    expect(settled).toBe(true);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  test("only one dialog opens when the preview is mounted twice", async () => {
    await mountHost();
    await mountHost();
    await requestRegenerate();
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  });

  test("a table without a readable recipe says so instead of opening an empty dialog", async () => {
    sdk.contentClient.getArtifact.mockResolvedValue(
      storedArtifact({ status: "failed", payloadJson: { table: { progress: { done: 0, total: 3 } } } }),
    );
    await mountHost();
    await requestRegenerate();
    expect(toasts.error).toHaveBeenCalledWith(
      "This table can't be adjusted. Generate a new table from the source hub.",
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  test("the web host asks the server whether the sources changed", async () => {
    const freshness = { state: "stale", changedSourceIds: ["source-1"], deletedSourceIds: [] };
    sdk.contentClient.getTableFreshness.mockResolvedValue(freshness);
    await expect(webTableHost.getFreshness!(version)).resolves.toEqual(freshness);
    expect(sdk.contentClient.getTableFreshness).toHaveBeenCalledWith("workspace-1", "artifact-1");
  });
});
