import assert from "node:assert/strict";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createTranslator, NextIntlClientProvider } from "next-intl";
import { test } from "vitest";
import { SidebarProvider } from "@sourceweft/ui-web/components/ui/sidebar";
import { DashboardSidebarChatPanel } from "./dashboard-sidebar-chat-panel";
import messages from "../../../messages/en.json";

import zhCN from "../../../messages/zh-CN.json";
import zhTW from "../../../messages/zh-TW.json";

const intlMessages = messages as ComponentProps<
  typeof NextIntlClientProvider
>["messages"];

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
function render(
  activeChatId: string,
  search = "",
  desktopTitlebar = false,
  locale = "en",
  catalog = intlMessages,
  includeChild = false,
  showCreateChat = true,
  pinnedChatIds: string[] = [],
) {
  const noop = () => {};
  const asyncNoop = async () => {};
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={catalog}
      timeZone="UTC"
      onError={(error) => {
        throw error;
      }}
    >
      {createElement(
        SidebarProvider,
        null,
        createElement(DashboardSidebarChatPanel, {
          desktopTitlebar,
          showCreateChat,
          heading: null,
          navigation: null,
          footer: null,
          search,
          onSearchChange: noop,
          activeChatId,
          privateChats: includeChild
            ? [
                {
                  ...chats[0]!,
                  children: [{ ...chats[1]!, parentThreadId: chats[0]!.id }],
                },
              ]
            : chats,
          sharedChats: [],
          archivedChats: [],
          hasMoreArchivedChats: false,
          isLoadingArchivedChats: false,
          workspaceId: "w",
          workspaceName: "Workspace",
          workspaces: [],
          hasMorePrivateChats: true,
          isLoadingPrivateChats: false,
          onArchiveChat: asyncNoop,
          onUnarchiveChat: asyncNoop,
          onRenameChat: asyncNoop,
          onTogglePinChat: asyncNoop,
          pinnedChatIds,
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
test("a search query replaces the loaded list with server results", () => {
  const html = render("mac", "cloud");
  assert.ok(!html.includes("Cloud research"));
  assert.ok(!html.includes("Mac research"));
  assert.ok(html.includes("Searching…"));
  assert.ok(!html.includes("Clear all private chats"));
});

test("pinned chats get their own section above the rest, in pin order", () => {
  const html = render("mac", "", false, "en", intlMessages, false, true, [
    "legacy",
    "other",
  ]);
  const pinned = html.indexOf(">Pinned<");
  assert.ok(pinned >= 0);
  const order = ["Legacy research", "Other computer research", "Cloud research"]
    .map((title) => html.indexOf(title));
  assert.ok(order.every((index) => index > pinned));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test("there is no pinned section without pins", () => {
  assert.ok(!render("mac").includes(">Pinned<"));
});

test("the PC client's first row holds the list actions beside the traffic lights", () => {
  const switcher = 'font-medium text-left">Workspace</span>';
  const desktop = render("cloud", "", true);
  // No spacer above the column, and no text beside the lights: the 56px row
  // level with the chat header carries only the icon actions, drags the
  // window by its blank space, and the workspace switcher follows it.
  assert.ok(!desktop.includes("pt-14"));
  assert.ok(!desktop.includes("h-10 shrink-0 select-none"));
  assert.ok(!desktop.includes("h-12 sm:h-14"));
  const row = desktop.match(
    /<div data-desktop-drag-region="" class="([^"]*)">([\s\S]*?)<div class="flex h-12 min-w-0 shrink-0 items-center gap-1 px-3">/,
  );
  assert.ok(row, "titlebar row not found");
  assert.ok(
    row[1]?.includes("h-14 select-none border-b border-sidebar-border pl-7"),
  );
  const actions = row[2] ?? "";
  assert.ok(actions.includes('<span class="flex-1 sr-only">Chats</span>'));
  for (const label of [
    "New agent chat",
    "Invite &amp; manage members",
    "Search all chats",
    "Filter chats",
  ])
    assert.ok(actions.includes(label), `${label} is not in the titlebar row`);
  assert.ok(!actions.includes(switcher));
  // The switcher is the second row, above the conversations.
  const switcherIndex = desktop.indexOf(switcher);
  assert.ok(switcherIndex > desktop.indexOf("Filter chats"));
  assert.ok(switcherIndex < desktop.indexOf("Cloud research"));

  const web = render("cloud");
  assert.ok(!web.includes("data-desktop-drag-region"));
  assert.ok(web.includes("h-12 sm:h-14"));
  assert.ok(!web.includes("pl-7"));
  // On the web the switcher stays first and the list keeps its label row.
  assert.ok(web.indexOf(switcher) < web.indexOf("Filter chats"));
  assert.ok(web.includes("uppercase tracking-[0.16em]"));
});

test("new chat aligns with navigation and search belongs to the chats header", () => {
  const html = render("cloud");
  const newChatIndex = html.indexOf("New chat");
  const chatsIndex = html.indexOf("Chats");
  const searchIndex = html.indexOf('aria-label="Search all chats"');

  assert.ok(html.includes("h-9 flex-1 justify-start gap-2 rounded-lg px-3"));
  assert.ok(newChatIndex >= 0);
  assert.ok(chatsIndex > newChatIndex);
  assert.ok(searchIndex > chatsIndex);
});

test("the PC column leaves New chat to the navigation rail", () => {
  const column = render("cloud", "", false, "en", intlMessages, false, false);
  assert.ok(!column.includes("New chat"));
  assert.ok(column.includes('aria-label="Search all chats"'));
});

// Catalog alignment misses keys absent in every language. Rendering invokes
// these translations even while the dropdown portal starts closed.
test("all sidebar action branches have real translations in every supported locale", () => {
  for (const [locale, catalog] of Object.entries({
    en: messages,
    "zh-CN": zhCN,
    "zh-TW": zhTW,
  })) {
    render("cloud", "", false, locale, catalog, true);
    const t = createTranslator({
      locale,
      messages: catalog,
      namespace: "dashboardNav.chats",
      onError: (error) => {
        throw error;
      },
    });
    for (const key of [
      "addSubagent",
      "openInNewWindow",
      "openBesideParent",
      "export",
      "share",
    ] as const) {
      assert.notEqual(t(key), `dashboardNav.chats.${key}`);
      assert.ok(t(key).length > 0);
    }
  }
});

test("sidebar rendering rejects each missing action key even if catalogs would otherwise align", () => {
  for (const key of [
    "addSubagent",
    "openInNewWindow",
    "openBesideParent",
    "export",
    "share",
  ]) {
    const broken = structuredClone(messages);
    Reflect.deleteProperty(broken.dashboardNav.chats, key);
    assert.throws(
      () => render("cloud", "", false, "en", broken, true),
      /MISSING_MESSAGE/,
    );
  }
});
