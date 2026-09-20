// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, test, vi, expect } from "vitest";
import type { DesktopUpdateState } from "../../../../lib/desktop-bridge";
const { api } = vi.hoisted(() => ({
  api: {
    state: vi.fn(),
    onState: vi.fn(),
    check: vi.fn(),
    preferences: vi.fn(),
    download: vi.fn(),
    install: vi.fn(),
    cancelDownload: vi.fn(),
    snooze: vi.fn(),
  },
}));
vi.mock("../../../../lib/desktop-bridge", () => ({ desktopUpdates: api }));
import { DesktopUpdatePanel } from "./desktop-update-panel";
let root: Root;
let container: HTMLDivElement;
const state = (
  patch: Partial<DesktopUpdateState> = {},
): DesktopUpdateState => ({
  protocolVersion: 1,
  revision: 1,
  currentVersion: "0.2.0",
  status: "ready",
  preferences: {
    schemaVersion: 1,
    channel: "preview",
    autoCheck: true,
    autoDownload: true,
  },
  candidateId: "candidate",
  version: "0.2.1-rc.1",
  notes: "<script>untrusted</script>",
  downloadedBytes: 10,
  totalBytes: 10,
  lastChecked: null,
  error: null,
  operationId: null,
  ...patch,
});
async function render(initial = state()) {
  vi.clearAllMocks();
  api.state.mockResolvedValue(initial);
  api.onState.mockResolvedValue(async () => {});
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(createElement(DesktopUpdatePanel));
  });
}
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
});
test("ready update requires explicit install and renders notes as text", async () => {
  await render();
  expect(api.install).not.toHaveBeenCalled();
  expect(container.querySelector("script")).toBeNull();
  expect(container.textContent).toContain("Preview + stable");
  const button = [...container.querySelectorAll("button")].find(
    (b) => b.textContent === "Install and restart",
  )!;
  await act(async () => {
    button.click();
  });
  expect(api.install).toHaveBeenCalledWith("candidate");
});
test("pause removes install and stale event cannot restore it", async () => {
  await render(
    state({
      revision: 8,
      status: "distributionPaused",
      error: "DISTRIBUTION_PAUSED",
    }),
  );
  const receive = api.onState.mock.calls[0]![0] as (
    s: DesktopUpdateState,
  ) => void;
  await act(async () => {
    receive(state({ revision: 7 }));
  });
  expect(container.textContent).toContain("Updates paused");
  expect(container.textContent).not.toContain("Install and restart");
});
test("automatic download may be disabled while downloading without changing channel", async () => {
  await render(state({ status: "downloading", operationId: "operation" }));
  expect(container.querySelector("select")?.disabled).toBe(true);
  const boxes = container.querySelectorAll<HTMLInputElement>(
    'input[type="checkbox"]',
  );
  await act(async () => {
    boxes[1]!.click();
  });
  expect(api.preferences).toHaveBeenCalledWith(
    expect.objectContaining({
      channel: "preview",
      autoDownload: false,
      autoCheck: true,
    }),
  );
});
