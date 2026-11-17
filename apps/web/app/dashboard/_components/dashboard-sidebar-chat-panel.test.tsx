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
          workspaceId: "w",
          workspaceName: "Workspace",
          workspaces: [],
          hasMorePrivateChats: true,
          isLoadingPrivateChats: false,
          onArchiveChat: noop,
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
test("sidebar text search spans all execution targets", () => {
  const html = render("mac", "cloud");
  assert.ok(html.includes("Cloud research"));
  assert.ok(!html.includes("Mac research"));
  assert.ok(!html.includes("Clear all private chats"));
});

test("the PC client puts the workspace switcher on the traffic lights' row", () => {
  const desktop = render("cloud", "", true);
  // One 56px row level with the chat header: no spacer above the switcher,
  // which is inset past the lights and drags the window by its blank space.
  assert.ok(!desktop.includes("pt-14"));
  assert.ok(!desktop.includes("h-10 shrink-0 select-none"));
  assert.ok(!desktop.includes("h-12 sm:h-14"));
  const row = desktop.match(
    /<div data-desktop-drag-region="" class="([^"]*)"><div class="min-w-0 flex-1">/,
  );
  assert.ok(row, "titlebar row not found");
  // Full column width, so its bottom line meets the chat header's.
  assert.ok(
    row[1]?.includes(
      "-mx-3 h-14 select-none border-b border-sidebar-border pl-7 pr-3",
    ),
  );

  const web = render("cloud");
  assert.ok(!web.includes("data-desktop-drag-region"));
  assert.ok(web.includes("h-12 sm:h-14"));
  assert.ok(!web.includes("pl-7"));
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
    ] as const) {
      assert.notEqual(t(key), `dashboardNav.chats.${key}`);
      assert.ok(t(key).length > 0);
    }
  }
});

test("sidebar rendering rejects each missing action key even if catalogs would otherwise align", () => {
  for (const key of ["addSubagent", "openInNewWindow", "openBesideParent"]) {
    const broken = structuredClone(messages);
    Reflect.deleteProperty(broken.dashboardNav.chats, key);
    assert.throws(
      () => render("cloud", "", false, "en", broken, true),
      /MISSING_MESSAGE/,
    );
  }
});
