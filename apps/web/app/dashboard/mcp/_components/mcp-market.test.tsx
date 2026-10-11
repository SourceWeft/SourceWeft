// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { marketItemSummarySchema } from "@sourceweft/market-contracts";

import { deepMergeMessages } from "@sourceweft/i18n/catalog";
import enMessages from "@/messages/en.json";
import zhCNMessages from "@/messages/zh-CN.json";
import { flush, mountWithIntl, unmountAll } from "@/test/react";

import { McpMarket } from "./mcp-market";

const api = vi.hoisted(() => ({
  getWorkspaceMarketMcp: vi.fn(),
  getWorkspaceMarketMcpCategoryCounts: vi.fn(),
  listWorkspaceMarketMcp: vi.fn(),
  listWorkspaceMarketMcpCategories: vi.fn(),
}));
const navigation = vi.hoisted(() => ({ search: "" }));

vi.mock("../../../../lib/sdk", () => ({
  contentClient: api,
  workspaceClient: { getCurrentContext: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(navigation.search),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("../../_components/dashboard-chat-state", () => ({
  useDashboardChatState: () => ({
    hasWorkspaceHydrated: true,
    switchWorkspace: vi.fn(),
    workspaceId: "ws-1",
    workspaceName: "Research",
    workspaces: [{ id: "ws-1", name: "Research" }],
  }),
}));
// Not under test, and each drags in its own network calls.
vi.mock("../../chat/_components/sources-hub/mcp/use-mcp", () => ({
  invalidateWorkspaceMcpCache: vi.fn(),
}));
vi.mock("./submit-mcp-dialog", () => ({ SubmitMcpDialog: () => null }));
vi.mock("./mcp-credentials-dialog", () => ({ CredentialsDialog: () => null }));

const SHA = "0123456789abcdef0123456789abcdef01234567";

function summary(identifier: string, name: string) {
  return marketItemSummarySchema.parse({
    createdAt: "2026-09-01T00:00:00.000Z",
    id: `id-${identifier}`,
    identifier,
    latestVersion: "1.0.0",
    name,
    status: "published",
    summary: `${name} summary.`,
    updatedAt: "2026-09-15T00:00:00.000Z",
    verified: true,
    visibility: "public",
  });
}

function detail(identifier: string, name: string) {
  return {
    install: null,
    market: {
      item: summary(identifier, name),
      readme: {
        markdown: `# ${name} README`,
        source: {
          blobUrl: `https://github.com/o/r/blob/${SHA}/README.md`,
          path: "README.md",
          rawUrl: `https://raw.githubusercontent.com/o/r/${SHA}/README.md`,
          ref: SHA,
          repoUrl: "https://github.com/o/r",
        },
        status: "ok",
      },
      versions: [],
    },
  };
}

const onPage = summary("io.github.o/on-page", "On Page");

beforeEach(() => {
  navigation.search = "";
  Element.prototype.scrollIntoView = vi.fn();
  api.listWorkspaceMarketMcp.mockResolvedValue({
    items: [{ install: null, market: onPage }],
    nextCursor: null,
  });
  api.listWorkspaceMarketMcpCategories.mockResolvedValue({ items: [] });
  api.getWorkspaceMarketMcpCategoryCounts.mockResolvedValue({
    counts: {},
    total: 1,
  });
  api.getWorkspaceMarketMcp.mockImplementation(
    async (_workspaceId: string, identifier: string) =>
      detail(
        identifier,
        identifier === onPage.identifier ? "On Page" : "Off Page",
      ),
  );
});
afterEach(async () => {
  await unmountAll();
  vi.resetAllMocks();
});

function dialog() {
  return document.querySelector<HTMLElement>('[role="dialog"]');
}

function tabLabels() {
  return [...(dialog()?.querySelectorAll('[role="tab"]') ?? [])].map(
    (node) => node.textContent,
  );
}

// Mounting the whole market with the README renderer takes a few seconds on a
// busy machine.
describe("McpMarket ?mcp= deep link", { timeout: 30_000 }, () => {
  it("opens the dialog, with its README tab, for a server on the loaded page", async () => {
    navigation.search = `mcp=${encodeURIComponent(onPage.identifier)}`;
    await mountWithIntl(<McpMarket />);
    await flush(4);

    expect(dialog()?.textContent).toContain("On Page");
    expect(api.getWorkspaceMarketMcp).toHaveBeenCalledWith(
      "ws-1",
      onPage.identifier,
      { locale: "en" },
    );
    expect(tabLabels()).toEqual(["Overview", "README", "Tools (0)"]);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
      block: "center",
    });
  });

  it("opens the dialog for a server that is not on the loaded page", async () => {
    const identifier = "io.github.o/off-page";
    navigation.search = `mcp=${encodeURIComponent(identifier)}`;
    await mountWithIntl(<McpMarket />);
    await flush(6);

    expect(dialog()?.textContent).toContain("Off Page");
    expect(api.getWorkspaceMarketMcp).toHaveBeenCalledWith("ws-1", identifier);
    expect(tabLabels()).toEqual(["Overview", "README", "Tools (0)"]);
  });

  it("opens no dialog without a deep link", async () => {
    await mountWithIntl(<McpMarket />);
    await flush(4);
    expect(document.body.textContent).toContain("On Page");
    expect(dialog()).toBeNull();
    expect(api.getWorkspaceMarketMcp).not.toHaveBeenCalled();
  });
});

describe("McpMarket categories", { timeout: 30_000 }, () => {
  const tooling = marketItemSummarySchema.parse({
    ...summary("io.github.o/tooling", "Tooling"),
    categories: ["developer-tools"],
  });
  const zhCN = {
    locale: "zh-CN",
    messages: deepMergeMessages(enMessages, zhCNMessages),
  };
  const unavailable =
    zhCNMessages.dashboardMcpPanel.filters.categoriesUnavailable;

  function categoryFacet() {
    return [...document.querySelectorAll("details")].find((node) =>
      node.querySelector("summary")?.textContent?.includes("分类"),
    );
  }
  function card(name: string) {
    return [...document.querySelectorAll("article")].find((node) =>
      node.textContent?.includes(name),
    );
  }

  beforeEach(() => {
    api.listWorkspaceMarketMcp.mockResolvedValue({
      items: [{ install: null, market: tooling }],
      nextCursor: null,
    });
  });

  it("says the categories are unavailable instead of showing a built-in English list", async () => {
    api.listWorkspaceMarketMcpCategories.mockRejectedValue(
      new Error("categories down"),
    );
    await mountWithIntl(<McpMarket />, zhCN);
    await flush(6);

    for (const english of [
      "Developer Tools",
      "Databases",
      "Browser Automation",
    ])
      expect(document.body.textContent).not.toContain(english);
    // Without names, a card shows no category rather than a raw slug.
    expect(card("Tooling")).toBeDefined();
    expect(card("Tooling")?.textContent?.toLowerCase()).not.toContain(
      "developer-tools",
    );
    const facet = categoryFacet();
    expect(facet?.textContent).toContain("全部");
    expect(unavailable).toBeTruthy();
    expect(facet?.textContent).toContain(unavailable);
  });

  it("still says how many categories are selected when a later load fails", async () => {
    api.listWorkspaceMarketMcpCategories
      .mockResolvedValueOnce({
        items: [{ slug: "developer-tools", name: "开发者工具" }],
      })
      .mockRejectedValue(new Error("categories down"));
    await mountWithIntl(<McpMarket />, zhCN);
    await flush(6);
    const choice = [
      ...(categoryFacet()?.querySelectorAll("button") ?? []),
    ].find((node) => node.textContent?.includes("开发者工具"));
    expect(choice).toBeDefined();
    await act(async () => choice!.click());
    await flush(6);

    // The selection still filters the list, so the facet must still show it.
    const summary = categoryFacet()?.querySelector("summary")?.textContent;
    expect(categoryFacet()?.textContent).toContain(unavailable);
    expect(summary).toContain("已选 1 个");
  });

  it("shows the categories again once a later load gets them", async () => {
    api.listWorkspaceMarketMcpCategories
      .mockRejectedValueOnce(new Error("categories down"))
      .mockResolvedValue({
        items: [{ slug: "developer-tools", name: "开发者工具" }],
      });
    const first = await mountWithIntl(<McpMarket />, zhCN);
    await flush(6);
    expect(categoryFacet()?.textContent).toContain(unavailable);
    await first.unmount();

    await mountWithIntl(<McpMarket />, zhCN);
    await flush(6);
    expect(categoryFacet()?.textContent).toContain("开发者工具");
    expect(categoryFacet()?.textContent).not.toContain(unavailable);
    expect(card("Tooling")?.textContent).toContain("开发者工具");
  });
});
