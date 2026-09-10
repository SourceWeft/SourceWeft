import assert from "node:assert/strict";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "vitest";
import { SidebarProvider } from "@sourceweft/ui-web/components/ui/sidebar";
import { DashboardSidebarChatPanel } from "./dashboard-sidebar-chat-panel";

const chats: ComponentProps<typeof DashboardSidebarChatPanel>["privateChats"] =
  [
    {
      id: "cloud",
      title: "Cloud research",
      executionTarget: { kind: "cloud" as const },
    },
    {
      id: "mac",
      title: "Mac research",
      executionTarget: { kind: "local" as const, deviceId: "mac" },
    },
    {
      id: "other",
      title: "Other computer research",
      executionTarget: { kind: "local" as const, deviceId: "other" },
    },
    { id: "legacy", title: "Legacy research" },
  ].map((item) => ({
    ...item,
    updatedAt: "2026-09-10T00:00:00Z",
    sourceCount: 0,
    visibility: "private" as const,
  }));
function render(activeChatId: string, search = "") {
  const noop = () => {};
  const asyncNoop = async () => {};
  return renderToStaticMarkup(
    createElement(
      SidebarProvider,
      null,
      createElement(DashboardSidebarChatPanel, {
        heading: null,
        navigation: null,
        footer: null,
        search,
        onSearchChange: noop,
        activeChatId,
        privateChats: chats,
        sharedChats: [],
        archivedChats: [],
        workspaceId: "w",
        workspaceName: "Workspace",
        workspaces: [],
        hasMorePrivateChats: true,
        isLoadingPrivateChats: false,
        onArchiveChat: noop,
        onClearArchivedChats: asyncNoop,
        onClearPrivateChats: asyncNoop,
        onCreateChat: noop,
        onDeleteChat: asyncNoop,
        onSetChatVisibility: asyncNoop,
        onLoadMoreChats: noop,
        onOpenChat: noop,
        onCreateWorkspace: asyncNoop,
        onRenameWorkspace: asyncNoop,
        onWorkspaceChange: noop,
      }),
    ),
  );
}
test("cloud, local, other computers and legacy conversations stay visible regardless of the active conversation", () => {
  for (const active of ["cloud", "mac", "other"]) {
    const html = render(active);
    for (const chat of chats) assert.ok(html.includes(chat.title));
    assert.ok(html.includes("Load more"));
    assert.ok(!html.includes("当前电脑的对话"));
    assert.ok(!html.includes("筛选对话列表"));
  }
});
test("sidebar text search spans all execution targets", () => {
  const html = render("mac", "cloud");
  assert.ok(html.includes("Cloud research"));
  assert.ok(!html.includes("Mac research"));
  assert.ok(!html.includes("Clear all private chats"));
});
