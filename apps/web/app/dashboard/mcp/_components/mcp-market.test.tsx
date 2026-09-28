// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { marketItemSummarySchema } from "@sourceweft/market-contracts";

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
