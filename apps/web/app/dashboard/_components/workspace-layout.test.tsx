// @vitest-environment jsdom
import assert from "node:assert/strict";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, test, vi } from "vitest";
import { resolveWorkspaceLayout } from "./workspace-layout";

vi.mock("@sourceweft/ui-web/components/ui/sidebar", () => ({
  useSidebar() {
    const [openMobile, setOpenMobile] = useState(false);
    return { openMobile, setOpenMobile };
  },
}));
import {
  DashboardWorkspaceLayout,
  useWorkspaceLayout,
} from "./dashboard-workspace-layout";

let root: Root;
let container: HTMLDivElement;
let width = 390;
let notifyResize: (() => void) | undefined;

function Harness() {
  const layout = useWorkspaceLayout();
  return createElement(
    "section",
    null,
    createElement("input", { "aria-label": "draft", defaultValue: "" }),
    createElement("output", null, JSON.stringify(layout)),
    createElement(
      "button",
      { onClick: layout.toggleConversations },
      "conversations",
    ),
    createElement(
      "button",
      { onClick: () => layout.setHubDrawerOpen(true) },
      "hub",
    ),
  );
}
const state = () => JSON.parse(container.querySelector("output")!.textContent!);
const resize = async (next: number) => {
  width = next;
  await act(async () => notifyResize?.());
};
const click = async (index: number) => {
  await act(async () => container.querySelectorAll("button")[index]!.click());
};

beforeEach(async () => {
  width = 390;
  localStorage.clear();
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
    () => width,
  );
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(640);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        notifyResize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(DashboardWorkspaceLayout, null, createElement(Harness)),
    ),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("supported PC sizes preserve at least 640px for chat when panels are docked", () => {
  for (let size = 960; size <= 2200; size += 8) {
    for (const preference of [true, false]) {
      const layout = resolveWorkspaceLayout(size, preference);
      assert(layout.contentWidth >= 640);
      if (layout.canDockHub) assert(layout.contentWidth - 360 >= 640);
      if (layout.canDockPreview)
        assert(layout.contentWidth - layout.previewWidth >= 640);
    }
  }
  assert.equal(resolveWorkspaceLayout(960).conversationsDocked, true);
  assert.equal(resolveWorkspaceLayout(1200).canDockHub, false);
  assert.equal(resolveWorkspaceLayout(1440).canDockHub, true);
});

test("automatic collapse and restoration preserve both a draft DOM node and explicit preferences", async () => {
  const draft = container.querySelector("input")!;
  draft.value = "未发送的草稿 / draft";
  await resize(1440);
  assert.equal(state().conversationsDocked, true);
  await resize(390);
  assert.equal(state().conversationsDocked, false);
  await resize(1440);
  assert.equal(state().conversationsDocked, true);
  assert.equal(container.querySelector("input"), draft);
  assert.equal(draft.value, "未发送的草稿 / draft");
  await click(0);
  assert.equal(
    localStorage.getItem("sourceweft:conversations-expanded"),
    "false",
  );
  await resize(390);
  await resize(1440);
  assert.equal(state().conversationsDocked, false);
});

test("compact drawers are mutually exclusive and resize closes overlays without erasing preferences", async () => {
  await click(0);
  assert.equal(state().conversationsOpen, true);
  await click(1);
  assert.equal(state().hubDrawerOpen, true);
  assert.equal(state().conversationsOpen, false);
  await click(0);
  assert.equal(state().hubDrawerOpen, false);
  assert.equal(state().conversationsOpen, true);
  await resize(1440);
  await resize(390);
  assert.equal(state().conversationsOpen, false);
  assert.equal(localStorage.getItem("sourceweft:conversations-expanded"), null);
});

test("desktop collapse keeps a 56px rail and only phone sizes hide navigation entirely", () => {
  for (const width of [320, 390, 767]) {
    assert.equal(resolveWorkspaceLayout(width).contentWidth, width);
    assert.equal(resolveWorkspaceLayout(width).conversationsDocked, false);
  }
  for (const width of [768, 800, 960, 1120, 1280, 1440]) {
    assert.equal(resolveWorkspaceLayout(width).contentWidth, width - 248);
    assert.equal(resolveWorkspaceLayout(width, false).contentWidth, width - 56);
  }
});
