// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  available: vi.fn(),
  info: vi.fn(),
  flush: vi.fn(),
  state: vi.fn(),
  onState: vi.fn(),
  onSave: vi.fn(),
  saved: vi.fn(),
  install: vi.fn(),
  cancel: vi.fn(),
  toast: Object.assign(vi.fn(), { error: vi.fn() }),
}));
vi.mock("../../../lib/chat-drafts", () => ({ flushChatDrafts: mocks.flush }));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("../../../lib/desktop-bridge", () => ({
  desktopBridge: { isAvailable: mocks.available, info: mocks.info },
  desktopUpdates: {
    state: mocks.state,
    onState: mocks.onState,
    onSave: mocks.onSave,
    saved: mocks.saved,
    install: mocks.install,
    cancelInstall: mocks.cancel,
  },
}));
import { DesktopUpdateRuntime } from "./desktop-update-runtime";
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.available.mockReturnValue(true);
  mocks.info.mockResolvedValue({ updaterProtocolVersion: 1 });
  mocks.state.mockResolvedValue({ revision: 1, status: "idle" });
  mocks.onState.mockResolvedValue(async () => {});
  mocks.onSave.mockResolvedValue(async () => {});
  mocks.saved.mockResolvedValue(undefined);
  mocks.flush.mockResolvedValue(undefined);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    queueMicrotask(() => callback(0));
    return 1;
  });
});
async function render() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(DesktopUpdateRuntime)));
}
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  vi.unstubAllGlobals();
});
test("save acknowledgement waits for real draft persistence", async () => {
  let finish!: () => void;
  mocks.flush.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await render();
  const save = mocks.onSave.mock.calls[0]![0] as (v: {
    operationId: string;
  }) => void;
  await act(async () => save({ operationId: "op" }));
  expect(mocks.saved).not.toHaveBeenCalled();
  await act(async () => finish());
  expect(mocks.saved).toHaveBeenCalledWith("op", null);
});
test("save failure is sent to native instead of acknowledging success", async () => {
  mocks.flush.mockRejectedValue(new Error("Disk full"));
  await render();
  await act(async () => mocks.onSave.mock.calls[0]![0]({ operationId: "op" }));
  expect(mocks.saved).toHaveBeenCalledWith("op", "Disk full");
  expect(mocks.install).not.toHaveBeenCalled();
});
test("old clients do not invoke unsupported update commands", async () => {
  mocks.info.mockResolvedValue({});
  await render();
  expect(mocks.onSave).not.toHaveBeenCalled();
  expect(mocks.state).not.toHaveBeenCalled();
});
