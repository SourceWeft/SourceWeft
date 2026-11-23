// @vitest-environment jsdom
import assert from "node:assert/strict";
import { createElement, type ComponentProps, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { test, vi } from "vitest";
import { SidebarProvider } from "@sourceweft/ui-web/components/ui/sidebar";
import messages from "../../../messages/en.json";

// Every menu rendered inline, so the test sees which actions a chat row
// offers without driving Radix's pointer handling.
vi.mock(
  "@sourceweft/ui-web/components/ui/dropdown-menu",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    DropdownMenu: ({ children }: { children: ReactNode }) => children,
    DropdownMenuTrigger: ({ children }: { children: ReactNode }) => children,
    DropdownMenuContent: ({ children }: { children: ReactNode }) => (
      <div role="menu">{children}</div>
    ),
    DropdownMenuItem: ({ children }: { children: ReactNode }) => (
      <div role="menuitem">{children}</div>
    ),
    DropdownMenuLabel: ({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    ),
    DropdownMenuRadioGroup: ({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    ),
    DropdownMenuRadioItem: ({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    ),
    DropdownMenuSeparator: () => null,
  }),
);

import { DashboardSidebarChatPanel } from "./dashboard-sidebar-chat-panel";

type Props = ComponentProps<typeof DashboardSidebarChatPanel>;

function chat(
  id: string,
  title: string,
  origin: NonNullable<Props["sharedChats"][number]["origin"]>,
): Props["sharedChats"][number] {
  return {
    id,
    title,
    origin,
    updatedAt: "2026-11-22T00:00:00Z",
    sourceCount: 0,
    visibility: "workspace",
  };
}

function menus(sharedChats: Props["sharedChats"]) {
  const noop = () => {};
  const asyncNoop = async () => {};
  const html = renderToStaticMarkup(
    <NextIntlClientProvider
      locale="en"
      messages={
        messages as ComponentProps<typeof NextIntlClientProvider>["messages"]
      }
      timeZone="UTC"
    >
      {createElement(
        SidebarProvider,
        null,
        createElement(DashboardSidebarChatPanel, {
          desktopTitlebar: false,
          showCreateChat: true,
          heading: null,
          navigation: null,
          footer: null,
          search: "",
          onSearchChange: noop,
          activeChatId: "",
          privateChats: [],
          sharedChats,
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
          onDeleteChat: asyncNoop,
          onSetChatVisibility: asyncNoop,
          onLoadMoreChats: noop,
          onOpenChat: noop,
          onOpenChatInNewWindow: noop,
          onOpenChatInPanel: noop,
          onCreateWorkspace: asyncNoop,
          onRenameWorkspace: asyncNoop,
          onWorkspaceChange: noop,
        }),
      )}
    </NextIntlClientProvider>,
  );
  const document = new DOMParser().parseFromString(html, "text/html");
  /** The actions in the menu of the chat row titled `title`. */
  return (title: string) => {
    const row = [...document.querySelectorAll("li")].find(
      (item) =>
        item.querySelector('[role="menu"]') &&
        item.textContent?.includes(title),
    );
    assert.ok(row, `a row for ${title}`);
    return [...row.querySelectorAll('[role="menuitem"]')].map(
      (item) => item.textContent ?? "",
    );
  };
}

test("a workspace assistant's ticket conversation offers no delete, archive or visibility change; an ordinary chat still does", () => {
  const actionsOf = menus([
    chat("ordinary", "Ordinary chat", "user"),
    chat("ticket", "Assistant ticket", "assistant_ticket"),
  ]);
  const ordinary = actionsOf("Ordinary chat");
  const ticket = actionsOf("Assistant ticket");
  for (const action of ["Delete", "Archive", "Make private"]) {
    assert.ok(ordinary.includes(action), `ordinary chat offers ${action}`);
    assert.ok(!ticket.includes(action), `ticket conversation hides ${action}`);
  }
  // Renaming it stays allowed.
  assert.ok(ticket.includes("Rename"));
});
