// @vitest-environment jsdom
import assert from "node:assert/strict";
import { act, createElement, useState } from "react";
import { afterEach, beforeEach, test, vi } from "vitest";
import { resolveWorkspaceLayout } from "./workspace-layout";

vi.mock("@sourceweft/ui-web/components/ui/sidebar", () => ({
  useSidebar() {
    const [openMobile, setOpenMobile] = useState(false);
    return { openMobile, setOpenMobile };
  },
}));
const route = vi.hoisted(() => ({ pathname: "/dashboard/chat" }));
vi.mock("next/navigation", () => ({ usePathname: () => route.pathname }));
import {
  DashboardWorkspaceLayout,
  useWorkspaceLayout,
} from "./dashboard-workspace-layout";
import { mount, unmountAll } from "@/test/react";

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
    createElement("button", { onClick: layout.closeConversations }, "close"),
  );
}
const state = () => JSON.parse(container.querySelector("output")!.textContent!);
const resize = async (next: number) => {
  width = next;
  await act(async () => notifyResize?.());
};
// A client navigation re-renders the provider with the new route.
let rerender: (() => void) | undefined;
function Root() {
  const [, setTick] = useState(0);
  rerender = () => setTick((tick) => tick + 1);
  return createElement(DashboardWorkspaceLayout, null, createElement(Harness));
}
const navigate = async (pathname: string) => {
  route.pathname = pathname;
  await act(async () => rerender?.());
};
const click = async (index: number) => {
  await act(async () => container.querySelectorAll("button")[index]!.click());
};

beforeEach(async () => {
  width = 390;
  route.pathname = "/dashboard/chat";
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
  ({ container } = await mount(createElement(Root)));
});
afterEach(async () => {
  await unmountAll();
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
  // Rail 56 + column 280 must still leave 640px of chat.
  assert.equal(resolveWorkspaceLayout(975).conversationsDocked, false);
  assert.equal(resolveWorkspaceLayout(976).conversationsDocked, true);
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

test("PC sizes always keep the 56px rail and only phones hide navigation", () => {
  for (const width of [320, 390, 767]) {
    const layout = resolveWorkspaceLayout(width);
    assert.equal(layout.railWidth, 0);
    assert.equal(layout.contentWidth, width);
    assert.equal(layout.conversationsDocked, false);
  }
  for (const width of [768, 800, 960, 976, 1120, 1280, 1440]) {
    assert.equal(resolveWorkspaceLayout(width, false).railWidth, 56);
    assert.equal(resolveWorkspaceLayout(width, false).contentWidth, width - 56);
  }
  for (const width of [976, 1120, 1280, 1440]) {
    assert.equal(resolveWorkspaceLayout(width).contentWidth, width - 56 - 280);
  }
});

test("the macOS client keeps the rail and insets headers only beside the traffic lights", () => {
  for (const width of [800, 960, 1280, 1440, 1920]) {
    const collapsed = resolveWorkspaceLayout(width, false, true);
    assert.equal(collapsed.railWidth, 56);
    assert.equal(collapsed.contentWidth, width - 56);
    assert.equal(collapsed.titlebarInset, true);
    assert.equal(
      resolveWorkspaceLayout(width, false, false).titlebarInset,
      false,
    );
  }
  const docked = resolveWorkspaceLayout(1440, true, true);
  assert.equal(docked.conversationsDocked, true);
  assert.equal(docked.titlebarInset, false);
});

test("the conversation list belongs to the chat pages only", () => {
  for (const width of [976, 1280, 1920]) {
    const page = resolveWorkspaceLayout(width, true, false, false);
    assert.equal(page.conversationRoute, false);
    assert.equal(page.canDockConversations, false);
    assert.equal(page.conversationsDocked, false);
    assert.equal(page.contentWidth, width - 56);
    assert.equal(
      resolveWorkspaceLayout(width, true, true, false).titlebarInset,
      true,
    );
  }
});

test("chat pages dock the list by default and keep one saved collapse; other pages never show it", async () => {
  await resize(1440);
  for (const pathname of [
    "/dashboard",
    "/dashboard/skills",
    "/dashboard/mcp",
  ]) {
    await navigate(pathname);
    assert.equal(state().conversationsDocked, false, pathname);
    // The rail navigates to chat here; the toggle has nothing to show.
    await click(0);
    assert.equal(state().conversationOverlayOpen, false);
    assert.equal(state().conversationsOpen, false);
  }
  assert.equal(localStorage.getItem("sourceweft:conversations-expanded"), null);
  await navigate("/dashboard/chat/thread");
  assert.equal(state().conversationsDocked, true);
  await click(0);
  assert.equal(state().conversationsDocked, false);
  assert.equal(
    localStorage.getItem("sourceweft:conversations-expanded"),
    "false",
  );
  await navigate("/dashboard/skills");
  await navigate("/dashboard/chat");
  assert.equal(state().conversationsDocked, false);
  await click(0);
  assert.equal(state().conversationsDocked, true);
});

test("a PC window too narrow to dock slides the list out and closes it on navigation", async () => {
  await resize(900);
  assert.equal(state().railWidth, 56);
  assert.equal(state().canDockConversations, false);
  assert.equal(state().conversationsDocked, false);
  await click(0);
  assert.equal(state().conversationOverlayOpen, true);
  assert.equal(state().conversationsOpen, true);
  assert.equal(localStorage.getItem("sourceweft:conversations-expanded"), null);
  await click(2);
  assert.equal(state().conversationOverlayOpen, false);
  // Choosing a conversation navigates, which closes it.
  await click(0);
  await navigate("/dashboard/chat/thread");
  assert.equal(state().conversationOverlayOpen, false);
  await click(0);
  await click(1);
  assert.equal(state().conversationOverlayOpen, false);
  assert.equal(state().hubDrawerOpen, true);
  await click(0);
  assert.equal(state().hubDrawerOpen, false);
  // Growing into docking or shrinking to a phone both close the overlay.
  await resize(1440);
  assert.equal(state().conversationOverlayOpen, false);
  assert.equal(state().conversationsDocked, true);
  await resize(900);
  await click(0);
  await resize(390);
  assert.equal(state().conversationOverlayOpen, false);
  assert.equal(state().conversationsOpen, false);
});
