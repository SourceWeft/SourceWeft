// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSourceSelection } from "./use-source-selection";

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), error: vi.fn() }));
vi.mock("../../../../../lib/sdk", () => ({
  contentClient: {
    getThreadSourceSelection: api.get,
    updateThreadSourceSelection: api.put,
  },
}));
vi.mock("sonner", () => ({ toast: { error: api.error } }));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function renderSelection(thread = "thread") {
  const result = {
    current: null as unknown as ReturnType<typeof useSourceSelection>,
  };
  function Probe({ thread }: { thread: string }) {
    result.current = useSourceSelection("ws", thread);
    return null;
  }
  async function rerender(thread: string) {
    await act(async () => root.render(createElement(Probe, { thread })));
  }
  await rerender(thread);
  return { result, rerender };
}

it("server empty selection takes precedence over stale browser storage", async () => {
  localStorage.setItem("chat:sources:ws:thread", JSON.stringify(["old"]));
  api.get.mockResolvedValue({
    selection: { revision: 4, selectedSourceIds: [] },
  });
  const { result } = await renderSelection();
  await act(async () => {});
  expect(result.current.sourceSelectionReady).toBe(true);
  expect(result.current.activeSourceIds).toEqual([]);
  expect(api.put).not.toHaveBeenCalled();
});

it("new-chat Sources remain an in-memory draft until a real conversation exists", async () => {
  const { result } = await renderSelection("current");
  expect(api.get).not.toHaveBeenCalled();
  await act(async () => {
    await result.current.persistActiveSourceIds(["chosen"]);
  });
  expect(result.current.activeSourceIds).toEqual(["chosen"]);
  expect(api.put).not.toHaveBeenCalled();
  expect(result.current.sourceSelectionReady).toBe(true);
});

it("serializes edits using each saved revision and persists clearing", async () => {
  api.get.mockResolvedValue({
    selection: { revision: 3, selectedSourceIds: ["old"] },
  });
  api.put.mockImplementation(async (_ws, _thread, input) => ({
    selection: {
      revision: input.expectedRevision + 1,
      selectedSourceIds: input.selectedSourceIds,
    },
  }));
  const { result } = await renderSelection();
  await act(async () => {});
  expect(result.current.sourceSelectionReady).toBe(true);
  await act(async () => {
    result.current.persistActiveSourceIds(["new"]);
    result.current.persistActiveSourceIds([]);
  });
  await act(async () => {});
  expect(result.current.sourceSelectionReady).toBe(true);
  expect(api.put.mock.calls.map((call) => call[2])).toEqual([
    { expectedRevision: 3, selectedSourceIds: ["new"] },
    { expectedRevision: 4, selectedSourceIds: [] },
  ]);
  expect(result.current.activeSourceIds).toEqual([]);
  expect(localStorage.getItem("chat:sources:ws:thread")).toBeNull();
});

it("a conflict blocks sending and never retries over another window's selection", async () => {
  api.get.mockResolvedValue({
    selection: { revision: 3, selectedSourceIds: [] },
  });
  api.put.mockRejectedValue(new Error("Sources changed in another window"));
  const { result } = await renderSelection();
  await act(async () => {});
  expect(result.current.sourceSelectionReady).toBe(true);
  await act(async () => result.current.persistActiveSourceIds(["stale"]));
  await act(async () => {});
  expect(api.error).toHaveBeenCalled();
  expect(result.current.sourceSelectionReady).toBe(false);
  await act(async () => result.current.persistActiveSourceIds(["retry"]));
  await act(async () => {});
  expect(api.put).toHaveBeenCalledTimes(1);
});

it("ignores a late bootstrap from another conversation", async () => {
  let finish!: (value: unknown) => void;
  api.get.mockImplementation((_workspace, thread) =>
    thread === "old"
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.resolve({
          selection: {
            revision: 2,
            selectedSourceIds: ["current"],
          },
        }),
  );
  const { result, rerender } = await renderSelection("old");
  await rerender("new");
  expect(result.current.activeSourceIds).toEqual(["current"]);
  await act(async () =>
    finish({
      selection: { revision: 1, selectedSourceIds: ["old"] },
    }),
  );
  expect(result.current.activeSourceIds).toEqual(["current"]);
});
