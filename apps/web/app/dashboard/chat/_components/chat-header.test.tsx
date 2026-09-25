import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, test, vi } from "vitest";
import { ChatHeader } from "./chat-header";
import { withIntl } from "@/test/react";

const layout = vi.hoisted(() => ({
  conversationsOpen: true,
  conversationsDocked: true,
  desktopTitlebar: true,
  canDockConversations: true,
  toggleConversations: vi.fn(),
}));

vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("../../../../lib/use-element-size", () => ({
  useElementSize: () => ({ ref: () => undefined, width: 900 }),
}));
vi.mock("../../_components/dashboard-workspace-layout", () => ({
  useWorkspaceLayout: () => layout,
}));
vi.mock("./chat-work-context", () => ({
  ChatWorkContext: () => createElement("span", null, "Work context"),
}));
vi.mock("./chat-hub-context", () => ({
  useChatHubContext: () => null,
}));

function renderHeader(extra: Partial<Parameters<typeof ChatHeader>[0]> = {}) {
  return renderToStaticMarkup(
    withIntl(
      createElement(ChatHeader, {
        ...extra,
        threadTitle: "Conversation title",
        workspaceId: "workspace",
        isPersistentLayout: true,
        sourcesVisible: false,
        onToggleSources: () => undefined,
        onOpenHub: () => undefined,
        selectedModels: { llm: null, image: null, vision: null },
        setSelectedModels: () => undefined,
      }),
    ),
  );
}

beforeEach(() => {
  layout.conversationsOpen = true;
  layout.conversationsDocked = true;
  layout.desktopTitlebar = true;
  layout.toggleConversations.mockReset();
});

test("desktop chat header places the conversation toggle before the title", () => {
  const html = renderHeader();
  const toggleIndex = html.indexOf('aria-label="Collapse sidebar"');
  const titleIndex = html.indexOf("Conversation title");

  assert.notEqual(toggleIndex, -1);
  assert.notEqual(titleIndex, -1);
  assert.ok(toggleIndex < titleIndex);
});

test("collapsed desktop chat header keeps the expand control beside the title", () => {
  layout.conversationsOpen = false;
  layout.conversationsDocked = false;

  const html = renderHeader();

  assert.match(html, /aria-label="Expand sidebar"/);
  assert.ok(
    html.indexOf('aria-label="Expand sidebar"') <
      html.indexOf("Conversation title"),
  );
});

test("a sub-agent thread shows its parent as a breadcrumb on the title's line", () => {
  const html = renderHeader({
    parentThread: { id: "parent", title: "Parent conversation" },
    onOpenParentThread: () => undefined,
  });
  // Parent link and title share one row, so the fixed-height header keeps its
  // two lines: breadcrumb + title, then the work context.
  const row = html.match(
    /<div class="flex min-w-0 items-center gap-1[^"]*">([\s\S]*?)<\/h1><\/div>/,
  );
  assert.ok(row, "breadcrumb row not found");
  const rowHtml = row[1] ?? "";
  assert.ok(
    rowHtml.indexOf("Parent conversation") <
      rowHtml.indexOf("Conversation title"),
  );
  assert.ok(html.indexOf("Conversation title") < html.indexOf("Work context"));
});
