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
  useDashboardChatState: () => ({
    activeChatId: "",
    archivedChats: [],
    privateChats: [],
    sharedChats: [],
    workspaces: [],
    workspaceId: "w",
    workspaceName: "Workspace",
    hasMorePrivateChats: false,
    isLoadingPrivateChats: false,
    mode: "new",
  }),
}));
vi.mock("./dashboard-account-menu", () => ({
  DashboardAccountMenu: () => createElement("span", null, "Account"),
}));
vi.mock("./dashboard-sidebar-brand", () => ({
  DashboardSidebarBrand: () => createElement("span", null, "Brand"),
}));
vi.mock("./market-admin-nav-link", () => ({
  MARKET_ADMIN_HREF: "/dashboard/admin/market",
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
  }) =>
    createElement(
      "div",
      {
        "data-panel": "",
        "data-show-create": String(props.showCreateChat ?? true),
      },
      props.heading,
      props.navigation,
      props.footer,
    ),
}));

import { DashboardSidebar } from "./dashboard-sidebar";

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
});
