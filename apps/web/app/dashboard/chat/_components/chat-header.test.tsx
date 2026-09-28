import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, test, vi } from "vitest";
import { ChatHeader } from "./chat-header";
import { withIntl } from "@/test/react";

const layout = vi.hoisted(() => ({
  conversationsOpen: true,
  desktopTitlebar: true,
  railWidth: 56,
  titlebarInset: false,
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
  layout.desktopTitlebar = true;
  layout.railWidth = 56;
  layout.titlebarInset = false;
  layout.toggleConversations.mockReset();
});

test("on PC the header's first control collapses and expands the conversation list", () => {
  const open = renderHeader();
  assert.match(open, /aria-label="Hide conversations"/);
  assert.ok(open.includes("lucide-panel-left-close"));
  assert.ok(
    open.indexOf("data-conversations-toggle") <
      open.indexOf("Conversation title"),
  );

  layout.conversationsOpen = false;
  const collapsed = renderHeader();
  assert.match(collapsed, /aria-label="Show conversations"/);
  assert.ok(collapsed.includes("lucide-panel-left-open"));
  assert.ok(
    !renderHeader({ embedMode: true }).includes("data-conversations-toggle"),
  );
});

test("phones open the drawer from the same place", () => {
  layout.railWidth = 0;
  layout.desktopTitlebar = false;
  layout.conversationsOpen = false;
  const closed = renderHeader();
  assert.match(closed, /aria-label="Show sidebar"/);
  assert.ok(
    closed.indexOf('aria-label="Show sidebar"') <
      closed.indexOf("Conversation title"),
  );
  layout.conversationsOpen = true;
  assert.match(renderHeader(), /aria-label="Hide sidebar"/);
});

test("the macOS header clears the traffic lights without the old 264px gap", () => {
  layout.titlebarInset = true;
  const inset = renderHeader();
  assert.ok(inset.includes("pl-6"));
  assert.ok(!inset.includes("pl-[264px]"));

  layout.titlebarInset = false;
  assert.ok(renderHeader().includes("pl-3 sm:pl-4"));
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
