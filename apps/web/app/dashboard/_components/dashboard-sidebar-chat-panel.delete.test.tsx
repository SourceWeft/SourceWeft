// @vitest-environment jsdom
import { createElement, type ComponentProps, type ReactNode } from "react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  contentClient: {
    listPersonas: vi.fn(async () => ({ items: [] })),
    searchThreads: vi.fn(async () => ({ items: [] })),
    exportThread: vi.fn(),
  },
}));
vi.mock("../../../lib/sdk", () => sdk);
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// The row menus render their items inline so the test can pick one.
vi.mock("@sourceweft/ui-web/components/ui/dropdown-menu", () => {
  const pass = ({ children }: { children?: ReactNode }) => children ?? null;
  const item = ({
    children,
    onSelect,
  }: {
    children: ReactNode;
    onSelect?: (event: Event) => void;
  }) =>
    createElement(
      "button",
      {
        role: "menuitem",
        type: "button",
        onClick: () => onSelect?.(new Event("select")),
      },
      children,
    );
  return {
    DropdownMenu: pass,
    DropdownMenuTrigger: pass,
    DropdownMenuContent: pass,
    DropdownMenuLabel: pass,
    DropdownMenuRadioGroup: pass,
    DropdownMenuSeparator: () => null,
    DropdownMenuItem: item,
    DropdownMenuRadioItem: item,
  };
});

import { SidebarProvider } from "@sourceweft/ui-web/components/ui/sidebar";
import { click, flush, mountWithIntl, unmountAll } from "@/test/react";
import { DashboardSidebarChatPanel } from "./dashboard-sidebar-chat-panel";

type PanelProps = ComponentProps<typeof DashboardSidebarChatPanel>;

beforeAll(() => {
  // The sidebar reads the viewport width; jsdom has no matchMedia.
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
});

afterEach(unmountAll);

const chat: PanelProps["privateChats"][number] = {
  id: "chat-1",
  title: "Quarterly plan",
  updatedAt: "2026-11-20T00:00:00Z",
  sourceCount: 0,
  visibility: "private",
};

async function mountPanel(onDeleteChat: PanelProps["onDeleteChat"]) {
  const noop = () => {};
  const asyncNoop = async () => {};
  await mountWithIntl(
    createElement(
      SidebarProvider,
      null,
      createElement(DashboardSidebarChatPanel, {
        heading: null,
        navigation: null,
        footer: null,
        search: "",
        onSearchChange: noop,
        activeChatId: "",
        privateChats: [chat],
        sharedChats: [],
        archivedChats: [],
        hasMoreArchivedChats: false,
        isLoadingArchivedChats: false,
        workspaceId: "w",
        workspaceName: "Workspace",
        workspaces: [],
        hasMorePrivateChats: false,
        isLoadingPrivateChats: false,
        onArchiveChat: asyncNoop,
        onUnarchiveChat: asyncNoop,
        onRenameChat: asyncNoop,
        onTogglePinChat: asyncNoop,
        pinnedChatIds: [],
        onLoadArchivedChats: asyncNoop,
        onLoadMoreArchivedChats: asyncNoop,
        onClearArchivedChats: asyncNoop,
        onClearPrivateChats: asyncNoop,
        onCreateAgentChat: asyncNoop,
        onCreateChat: noop,
        onDeleteChat,
        onSetChatVisibility: asyncNoop,
        onLoadMoreChats: noop,
        onOpenChat: noop,
        onOpenChatInNewWindow: noop,
        onOpenChatInPanel: noop,
        onCreateWorkspace: asyncNoop,
        onRenameWorkspace: asyncNoop,
        onWorkspaceChange: noop,
      }),
    ),
  );
}

function deleteMenuItem() {
  const items = [
    ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ].filter((node) => node.textContent?.trim() === "Delete");
  expect(items).toHaveLength(1);
  return items[0]!;
}

function dialogButton(label: string) {
  const dialog = document.querySelector<HTMLElement>('[role="alertdialog"], [role="dialog"]');
  expect(dialog).not.toBeNull();
  const found = [...dialog!.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === label,
  );
  expect(found).toBeDefined();
  return found!;
}

test("Delete in a chat's menu asks first and deletes only after confirming", async () => {
  const onDeleteChat = vi.fn(async () => {});
  await mountPanel(onDeleteChat);

  await click(deleteMenuItem());

  expect(onDeleteChat).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("Delete this chat?");

  await click(dialogButton("Delete"));
  await flush(2);

  expect(onDeleteChat).toHaveBeenCalledTimes(1);
  expect(onDeleteChat).toHaveBeenCalledWith("chat-1");
});

test("cancelling the confirmation keeps the chat", async () => {
  const onDeleteChat = vi.fn(async () => {});
  await mountPanel(onDeleteChat);

  await click(deleteMenuItem());
  await click(dialogButton("Cancel"));
  await flush(2);

  expect(onDeleteChat).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toContain("Delete this chat?");
});
