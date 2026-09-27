// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type MarketMcpReadme,
  type McpReadmeStatus,
  marketItemSummarySchema,
} from "@sourceweft/market-contracts";

import { flush, mountWithIntl, unmountAll } from "@/test/react";

import McpDetailPage from "./page";

const api = vi.hoisted(() => ({ getWorkspaceMarketMcp: vi.fn() }));
const route = vi.hoisted(() => ({ identifier: "io.github.o/weather" }));

vi.mock("../../../../lib/sdk", () => ({
  contentClient: api,
  workspaceClient: { getCurrentContext: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ identifier: route.identifier }),
}));
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("../../_components/dashboard-chat-state", () => ({
  useDashboardChatState: () => ({
    workspaceId: "ws-1",
    workspaceName: "Research",
  }),
}));
// Not under test, and each drags in its own network calls.
vi.mock("../../chat/_components/sources-hub/mcp/use-mcp", () => ({
  invalidateWorkspaceMcpCache: vi.fn(),
}));
vi.mock("../_components/mcp-credentials-dialog", () => ({
  CredentialsDialog: () => null,
}));

const SHA = "0123456789abcdef0123456789abcdef01234567";

function summary(patch: Record<string, unknown> = {}) {
  return marketItemSummarySchema.parse({
    createdAt: "2026-09-01T00:00:00.000Z",
    id: "mcp-1",
    identifier: route.identifier,
    latestVersion: "1.0.0",
    name: "Weather",
    status: "published",
    summary: "Forecasts for any city.",
    toolsCount: 2,
    updatedAt: "2026-09-15T00:00:00.000Z",
    verified: true,
    visibility: "public",
    ...patch,
  });
}

function readme(
  status: McpReadmeStatus,
  patch: Partial<MarketMcpReadme> = {},
): MarketMcpReadme {
  return {
    status,
    ...(status === "ok"
      ? {
          markdown:
            "# Weather MCP\n\nRead [the setup guide](docs/setup.md).\n\n![Architecture](img/arch.png)",
        }
      : {}),
    source: {
      blobUrl: `https://github.com/o/r/blob/${SHA}/mcp/README.md`,
      path: "mcp/README.md",
      rawUrl: `https://raw.githubusercontent.com/o/r/${SHA}/mcp/README.md`,
      ref: SHA,
      repoUrl: "https://github.com/o/r",
    },
    ...patch,
  };
}

/** The workspace detail: `market` is the public detail, README included. */
function detail(value?: MarketMcpReadme | null, itemPatch = {}) {
  return {
    install: null,
    market: {
      item: summary(itemPatch),
      ...(value === undefined ? {} : { readme: value }),
      versions: [
        {
          manifestJson: {
            description: "Forecasts and alerts for any city.",
            identifier: route.identifier,
            name: "Weather",
            schemaVersion: 1,
            summary: "Forecasts for any city.",
            tools: [
              {
                description: "Daily forecast.",
                name: "forecast",
                risk: "read",
              },
              { name: "alerts", risk: "read" },
            ],
            transport: "streamable_http",
            version: "1.0.0",
          },
          status: "published",
          version: "1.0.0",
        },
      ],
    },
  };
}

async function open(value?: MarketMcpReadme | null, itemPatch = {}) {
  api.getWorkspaceMarketMcp.mockResolvedValue(detail(value, itemPatch));
  await mountWithIntl(<McpDetailPage />);
  await flush(4);
}

function tabs() {
  return [...document.querySelectorAll<HTMLElement>('[role="tab"]')];
}

function tab(label: string) {
  const match = tabs().find((node) => node.textContent === label);
  if (!match) throw new Error(`No tab named ${label}`);
  return match;
}

function activePanel() {
  return document.querySelector<HTMLElement>(
    '[role="tabpanel"][data-state="active"]',
  )!;
}

// Radix tabs activate on a primary-button mousedown, not on click.
async function select(label: string) {
  await act(async () => {
    tab(label).dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 0 }),
    );
  });
}

beforeEach(() => {
  api.getWorkspaceMarketMcp.mockReset();
});
afterEach(async () => {
  await unmountAll();
});

// Rendering README markdown in jsdom takes a few seconds on a busy machine.
describe("dashboard MCP detail page", { timeout: 30_000 }, () => {
  it("opens on Overview, with README and Tools beside it", async () => {
    await open(readme("ok"));
    expect(api.getWorkspaceMarketMcp).toHaveBeenCalledWith(
      "ws-1",
      route.identifier,
    );
    expect(tabs().map((node) => node.textContent)).toEqual([
      "Overview",
      "README",
      "Tools (2)",
    ]);
    expect(tab("Overview").getAttribute("aria-selected")).toBe("true");
    expect(activePanel().textContent).toContain(
      "Forecasts and alerts for any city.",
    );
  });

  it("shows the README, resolved against its own address, on its tab", async () => {
    await open(readme("ok"));
    await select("README");
    const panel = activePanel();
    expect(panel.querySelector("h2")?.textContent).toBe("Weather MCP");
    expect(
      panel.querySelector<HTMLAnchorElement>('a[href$="docs/setup.md"]')?.href,
    ).toBe(`https://github.com/o/r/blob/${SHA}/mcp/docs/setup.md`);
    expect(panel.querySelector("img")).toBeNull();
    const picture = panel.querySelector<HTMLAnchorElement>(
      'a[href$="img/arch.png"]',
    )!;
    expect(picture.href).toBe(
      `https://raw.githubusercontent.com/o/r/${SHA}/mcp/img/arch.png`,
    );
    expect(picture.textContent).toBe("[Architecture]");
    expect(panel.textContent).toContain(
      "Source: mcp/README.md at commit 0123456",
    );
  });

  it("lists the tools on their tab", async () => {
    await open(readme("ok"));
    await select("Tools (2)");
    expect(
      [...activePanel().querySelectorAll("li")].map(
        (node) => node.querySelector("span")?.textContent,
      ),
    ).toEqual(["forecast", "alerts"]);
  });

  it("explains a missing README and offers the repository when it could not be read", async () => {
    await open(readme("not_found", { source: null }));
    await select("README");
    expect(activePanel().textContent).toBe("This repository has no README.");
    await unmountAll();

    await open(readme("unsupported_host"));
    await select("README");
    const link = activePanel().querySelector<HTMLAnchorElement>("a")!;
    expect(link.textContent).toBe("Read the README in its repository");
    expect(link.href).toBe("https://github.com/o/r");
  });

  it("hides the README tab while pending or without a README", async () => {
    for (const value of [readme("pending"), null, undefined]) {
      await open(value);
      expect(tabs().map((node) => node.textContent)).toEqual([
        "Overview",
        "Tools (2)",
      ]);
      await unmountAll();
    }
  });

  it("keeps the unverified notice above the tabs", async () => {
    await open(readme("ok"), { verified: false });
    const notice = [...document.querySelectorAll("section")].find((node) =>
      node.textContent?.startsWith("This MCP server is unverified."),
    )!;
    const tabList = document.querySelector('[role="tablist"]')!;
    expect(
      notice.compareDocumentPosition(tabList) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await select("Tools (2)");
    expect(notice.isConnected).toBe(true);
  });

  it("puts the Runtime & security heading on its own line above its text", async () => {
    await open(readme("ok"));
    const heading = [...document.querySelectorAll("h2")].find(
      (node) => node.textContent === "Runtime & security",
    )!;
    expect(heading.classList.contains("flex")).toBe(true);
    expect(heading.classList.contains("inline-flex")).toBe(false);
    const body = heading.nextElementSibling!;
    expect(body.tagName).toBe("P");
    expect(body.textContent).toMatch(/^Credentials are configured privately/);
  });
});
