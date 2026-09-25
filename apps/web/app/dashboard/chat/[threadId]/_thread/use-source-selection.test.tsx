// @vitest-environment jsdom
import { act, createElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSourceSelection } from "./use-source-selection";
import { mountWithIntl, unmountAll, withIntl } from "@/test/react";

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), error: vi.fn() }));
vi.mock("../../../../../lib/sdk", () => ({
  contentClient: {
    getThreadSourceSelection: api.get,
    updateThreadSourceSelection: api.put,
  },
}));
vi.mock("sonner", () => ({ toast: { error: api.error } }));
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(unmountAll);
async function renderSelection(thread = "thread") {
  const result = {
    current: null as unknown as ReturnType<typeof useSourceSelection>,
  };
  function Probe({ thread }: { thread: string }) {
    result.current = useSourceSelection("ws", thread);
    return null;
  }
  const view = await mountWithIntl(createElement(Probe, { thread }));
  async function rerender(thread: string) {
    await view.render(withIntl(createElement(Probe, { thread })));
  }
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
