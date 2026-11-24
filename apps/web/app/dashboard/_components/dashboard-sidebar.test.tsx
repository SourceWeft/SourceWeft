// @vitest-environment jsdom
import assert from "node:assert/strict";
import { act, createElement, type ReactNode } from "react";
import { afterEach, beforeEach, test, vi } from "vitest";
import { mountWithIntl, unmountAll } from "@/test/react";

const route = vi.hoisted(() => ({ pathname: "/dashboard/chat/t1" }));
const router = vi.hoisted(() => ({ push: vi.fn(), prefetch: vi.fn() }));
const layout = vi.hoisted(() => ({
  closeConversations: vi.fn(),
  conversationRoute: true,
  conversationOverlayOpen: false,
  conversationsDocked: true,
  conversationsOpen: true,
  desktopTitlebar: false,
  conversationWidth: 280,
  railWidth: 56,
  toggleConversations: vi.fn(),
}));

const chatState = vi.hoisted(() => ({
  activeChatId: "",
  archivedChats: [] as ChatItem[],
  privateChats: [] as ChatItem[],
  sharedChats: [] as ChatItem[],
  workspaces: [],
  workspaceId: "w",
  workspaceName: "Workspace",
  hasMorePrivateChats: false,
  isLoadingPrivateChats: false,
  mode: "new",
  deleteChat: vi.fn(async () => {}),
  clearPrivateChats: vi.fn(async () => {}),
  clearArchivedChats: vi.fn(async () => {}),
}));
// The handlers the sidebar hands to the conversation list.
const panel = vi.hoisted(() => ({
  props: null as null | {
    onDeleteChat: (id: string) => Promise<void>;
    onClearPrivateChats: () => Promise<void>;
    onClearArchivedChats: () => Promise<void>;
  },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => route.pathname,
  useRouter: () => router,
}));
vi.mock("../../../lib/sdk", () => ({ contentClient: {} }));
vi.mock("@sourceweft/ui-web/components/ui/sidebar", () => ({
  useSidebar: () => ({ openMobile: false, setOpenMobile: vi.fn() }),
}));
vi.mock("./dashboard-workspace-layout", () => ({
  useWorkspaceLayout: () => layout,
}));
vi.mock("./dashboard-chat-state", () => ({
  useDashboardChatState: () => chatState,
}));
vi.mock("./dashboard-mobile-nav-state", () => ({
  useDashboardMobileNav: () => ({ openMain: vi.fn(), openMe: vi.fn() }),
}));
vi.mock("./dashboard-mobile-me-entry", () => ({
  DashboardMobileMeEntry: () => createElement("span", null, "Me"),
}));
vi.mock("./dashboard-account-menu", () => ({
  DashboardAccountMenu: () => createElement("span", null, "Account"),
}));
vi.mock("../scheduled/_components/notification-bell", () => ({
  NotificationBell: () => createElement("span", null, "Bell"),
}));
vi.mock("./dashboard-sidebar-brand", () => ({
  DashboardSidebarBrand: () => createElement("span", null, "Brand"),
}));
vi.mock("./market-admin-nav-link", () => ({
  MARKET_ADMIN_HREF: "/dashboard/admin",
  MarketAdminNavLink: () =>
    createElement("span", { "data-market-admin": "" }, "Market admin"),
}));
vi.mock("./workspace-members-dialog", () => ({
  WorkspaceMembersDialog: () => null,
}));
vi.mock("../chat/_components/byok-state", () => ({
  copyStoredByokState: vi.fn(),
}));
// Menus render their content inline so the test reads what "More" holds.
vi.mock("@sourceweft/ui-web/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => children,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => children,
  DropdownMenuContent: ({ children }: { children: ReactNode }) =>
    createElement("div", { role: "menu" }, children),
  DropdownMenuItem: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./dashboard-sidebar-chat-panel", () => ({
  DashboardSidebarChatPanel: (props: {
    showCreateChat?: boolean;
    navigation: ReactNode;
    heading: ReactNode;
    footer: ReactNode;
    onDeleteChat: (id: string) => Promise<void>;
    onClearPrivateChats: () => Promise<void>;
    onClearArchivedChats: () => Promise<void>;
  }) => {
    panel.props = props;
    return createElement(
      "div",
      {
        "data-panel": "",
        "data-show-create": String(props.showCreateChat ?? true),
      },
      props.heading,
      props.navigation,
      props.footer,
    );
  },
}));

import { DashboardSidebar } from "./dashboard-sidebar";
import type { ChatItem } from "./dashboard-chat-types";

function chatItem(id: string, extra: Partial<ChatItem> = {}): ChatItem {
  return {
    id,
    title: id,
    updatedAt: "2026-09-01T00:00:00.000Z",
    sourceCount: 0,
    visibility: "private",
    status: "ready",
    parentThreadId: null,
    personaId: null,
    ...extra,
  };
}

/** A chat whose delegation opened `task` and under which a member created `created`. */
function chatWithChildren(): ChatItem {
  return chatItem("parent", {
    children: [
      chatItem("task", { parentThreadId: "parent", origin: "subagent" }),
      chatItem("created", { parentThreadId: "parent", origin: "user" }),
    ],
  });
}

async function render(state: {
  pathname: string;
  docked?: boolean;
  overlay?: boolean;
}) {
  route.pathname = state.pathname;
  layout.conversationRoute = state.pathname.startsWith("/dashboard/chat");
  layout.conversationsDocked = state.docked ?? false;
  layout.conversationOverlayOpen = state.overlay ?? false;
  layout.conversationsOpen = Boolean(state.docked || state.overlay);
  const { container } = await mountWithIntl(createElement(DashboardSidebar));
  return container;
}

beforeEach(() => {
  chatState.privateChats = [];
  chatState.sharedChats = [];
  chatState.archivedChats = [];
  panel.props = null;
  layout.closeConversations.mockReset();
  layout.toggleConversations.mockReset();
  router.push.mockReset();
  layout.desktopTitlebar = false;
});
afterEach(async () => {
  await unmountAll();
});

test("the rail links to chat like any page and leaves the list toggle to the chat header", async () => {
  for (const pathname of [
    "/dashboard/chat/t1",
    "/dashboard",
    "/dashboard/skills",
    "/dashboard/mcp",
  ]) {
    const chat = pathname.startsWith("/dashboard/chat");
    const container = await render({ pathname, docked: chat });
    const rail = container.querySelector('[data-testid="navigation-rail"]')!;
    assert.equal(container.querySelector("[data-conversations-toggle]"), null);
    // Brand, then New chat first: the same spot on every page.
    const controls = [...rail.querySelectorAll("button, a")];
    assert.equal(controls[0]?.getAttribute("aria-label"), "New chat");
    const chatLink = rail.querySelector<HTMLAnchorElement>(
      'nav > a[href="/dashboard/chat"]',
    )!;
    assert.equal(chatLink.getAttribute("aria-label"), "Chat");
    assert.ok(chatLink.querySelector("svg.lucide-message-square-text"));
    assert.equal(chatLink.getAttribute("aria-current"), chat ? "page" : null);
    assert.equal(
      Boolean(container.querySelector('[data-testid="conversation-sidebar"]')),
      chat,
    );
    await unmountAll();
  }
});

test("the docked column and the overlay hold only the conversations", async () => {
  const docked = await render({ pathname: "/dashboard/chat/t1", docked: true });
  const column = docked.querySelector('[data-testid="conversation-sidebar"]')!;
  assert.equal(
    column.querySelector("[data-panel]")?.getAttribute("data-show-create"),
    "false",
  );
  assert.equal(column.querySelector("nav"), null);
  assert.ok(!column.textContent?.includes("Account"));
  assert.equal(
    docked.querySelector('[data-testid="conversation-overlay"]'),
    null,
  );
  await unmountAll();

  const page = await render({ pathname: "/dashboard/chat", overlay: true });
  assert.equal(
    page.querySelector('[data-testid="conversation-sidebar"]'),
    null,
  );
  const overlay = page.querySelector('[data-testid="conversation-overlay"]')!;
  assert.equal(
    overlay.querySelector("[data-panel]")?.getAttribute("data-show-create"),
    "false",
  );
  assert.equal(document.activeElement, overlay);
});

test("Escape, a click beside it and its own toggle all close the overlay", async () => {
  const container = await render({
    pathname: "/dashboard/chat/t1",
    overlay: true,
  });
  // The chat header owns the toggle; focus returns to it.
  const toggle = document.createElement("button");
  toggle.setAttribute("data-conversations-toggle", "");
  document.body.append(toggle);
  const overlay = container.querySelector<HTMLElement>(
    '[data-testid="conversation-overlay"]',
  )!;
  await act(async () => {
    overlay.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
  assert.equal(layout.closeConversations.mock.calls.length, 1);
  assert.equal(document.activeElement, toggle);
  toggle.remove();

  const backdrop = container.querySelector<HTMLElement>(
    '[data-testid="conversation-overlay-backdrop"]',
  )!;
  await act(async () => backdrop.click());
  assert.equal(layout.closeConversations.mock.calls.length, 2);

  // It covers the chat header's toggle, so it carries its own.
  const close = overlay.querySelector<HTMLButtonElement>(
    '[aria-label="Hide conversations"]',
  )!;
  assert.ok(close.querySelector("svg.lucide-panel-left-close"));
  await act(async () => close.click());
  assert.equal(layout.closeConversations.mock.calls.length, 3);
});

test("the rail links primary pages and keeps secondary ones under More", async () => {
  const container = await render({ pathname: "/dashboard/observability" });
  const rail = container.querySelector('[data-testid="navigation-rail"]')!;
  const links = [...rail.querySelectorAll("nav > a")].map((a) =>
    a.getAttribute("href"),
  );
  assert.deepEqual(links, [
    "/dashboard",
    "/dashboard/chat",
    "/dashboard/skills",
    "/dashboard/mcp",
  ]);

  const more = rail.querySelector<HTMLButtonElement>('[aria-label="More"]')!;
  assert.ok(more.className.includes("bg-sidebar-accent"));
  const menu = rail.querySelector('[role="menu"]')!;
  assert.ok(menu.querySelector('a[href="/dashboard/observability"]'));
  assert.ok(menu.querySelector('a[href="/dashboard/scheduled"]'));
  assert.ok(menu.querySelector("[data-market-admin]"));
});

test("the macOS rail leaves the traffic lights a drag strip instead of the brand", async () => {
  layout.desktopTitlebar = true;
  const container = await render({
    pathname: "/dashboard/chat/t1",
    docked: true,
  });
  const rail = container.querySelector('[data-testid="navigation-rail"]')!;
  const strip = rail.firstElementChild!;
  assert.ok(strip.hasAttribute("data-desktop-drag-region"));
  assert.ok(!rail.textContent?.includes("Brand"));
  // The lights reach past the rail, so the strip matches the 56px header row:
  // that row's bottom line carries across the rail, and the rail's edge
  // starts at it instead of running between the lights.
  assert.ok(strip.className.includes("h-14"));
  assert.ok(!rail.className.includes("border-r"));
  const edge = rail.querySelector('[data-testid="navigation-rail-edge"]')!;
  assert.ok(
    edge.className.includes("inset-x-0 bottom-0 top-[55px] border-r border-t"),
  );
});

test("the web rail keeps its full-height edge", async () => {
  layout.desktopTitlebar = false;
  const container = await render({
    pathname: "/dashboard/chat/t1",
    docked: true,
  });
  const rail = container.querySelector('[data-testid="navigation-rail"]')!;
  assert.ok(rail.className.includes("border-r"));
  assert.ok(!rail.querySelector('[data-testid="navigation-rail-edge"]'));
});

test("deleting a chat leaves the open conversation when the delete takes it away", async () => {
  const cases: Array<[open: string, leaves: boolean]> = [
    ["parent", true],
    // Opened by the chat's own delegation: the server deletes it with the chat.
    ["task", true],
    // Created by a member under the chat: the server keeps it.
    ["created", false],
    ["other", false],
  ];
  for (const [open, leaves] of cases) {
    chatState.privateChats = [chatWithChildren(), chatItem("other")];
    await render({ pathname: `/dashboard/chat/${open}`, docked: true });
    router.push.mockReset();

    await act(() => panel.props!.onDeleteChat("parent"));

    assert.deepEqual(
      router.push.mock.calls,
      leaves ? [["/dashboard/chat"]] : [],
      `open conversation: ${open}`,
    );
    await unmountAll();
  }
});

test("clearing private or archived chats leaves an open conversation their delegations opened", async () => {
  chatState.privateChats = [chatWithChildren()];
  await render({ pathname: "/dashboard/chat/task", docked: true });
  router.push.mockReset();
  await act(() => panel.props!.onClearPrivateChats());
  assert.deepEqual(router.push.mock.calls, [["/dashboard/chat"]]);
  await unmountAll();

  chatState.privateChats = [];
  chatState.archivedChats = [chatWithChildren()];
  await render({ pathname: "/dashboard/chat/task", docked: true });
  router.push.mockReset();
  await act(() => panel.props!.onClearArchivedChats());
  assert.deepEqual(router.push.mock.calls, [["/dashboard/chat"]]);
  await unmountAll();

  // A conversation a member created under a cleared chat is kept.
  chatState.archivedChats = [chatWithChildren()];
  await render({ pathname: "/dashboard/chat/created", docked: true });
  router.push.mockReset();
  await act(() => panel.props!.onClearArchivedChats());
  assert.deepEqual(router.push.mock.calls, []);
});
