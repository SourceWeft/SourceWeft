// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { marketItemSummarySchema } from "@sourceweft/market-contracts";

import type { McpReadmePayload, McpReadmeStatus } from "@/lib/mcp-readme";
import { mountWithIntl, unmountAll } from "@/test/react";

import { McpDetailDialog } from "./mcp-detail-dialog";

const api = vi.hoisted(() => ({ getWorkspaceMarketMcp: vi.fn() }));
vi.mock("../../../../lib/sdk", () => ({ contentClient: api }));

const SHA = "0123456789abcdef0123456789abcdef01234567";
const IDENTIFIER = "io.github.o/weather";

const summary = marketItemSummarySchema.parse({
  createdAt: "2026-09-01T00:00:00.000Z",
  id: "mcp-1",
  identifier: IDENTIFIER,
  kind: "mcp",
  latestVersion: "1.0.0",
  name: "Weather",
  status: "published",
  summary: "Forecasts for any city.",
  toolsCount: 2,
  updatedAt: "2026-09-15T00:00:00.000Z",
  verified: true,
  visibility: "public",
});

function readme(
  status: McpReadmeStatus,
  patch: Partial<McpReadmePayload> = {},
): McpReadmePayload {
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
function detail(value?: McpReadmePayload | null) {
  return {
    install: null,
    market: {
      item: summary,
      ...(value === undefined ? {} : { readme: value }),
      versions: [
        {
          manifestJson: {
            description: "Forecasts and alerts for any city.",
            identifier: IDENTIFIER,
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

async function open(value?: McpReadmePayload | null) {
  api.getWorkspaceMarketMcp.mockResolvedValue(detail(value));
  await mountWithIntl(
    <McpDetailDialog
      item={{ install: null, market: summary }}
      onConfigure={vi.fn()}
      onInstall={vi.fn()}
      onOpenChange={vi.fn()}
      onTest={vi.fn()}
      onToggleEnabled={vi.fn()}
      onUninstall={vi.fn()}
      pending={false}
      workspaceId="ws-1"
    />,
  );
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
describe("McpDetailDialog tabs", { timeout: 30_000 }, () => {
  it("opens on Overview, with README and Tools beside it", async () => {
    await open(readme("ok"));
    expect(api.getWorkspaceMarketMcp).toHaveBeenCalledWith("ws-1", IDENTIFIER);
    expect(tabs().map((node) => node.textContent)).toEqual([
      "Overview",
      "README",
      "Tools (2)",
    ]);
    expect(tab("Overview").getAttribute("aria-selected")).toBe("true");
    expect(activePanel().textContent).toContain(
      "Forecasts and alerts for any city.",
    );
    expect(activePanel().textContent).toContain("Verified");
  });

  it("shows the README, resolved against its own address, on its tab", async () => {
    await open(readme("ok"));
    await select("README");
    const panel = activePanel();
    expect(tab("README").getAttribute("aria-selected")).toBe("true");
    expect(panel.querySelector("h2")?.textContent).toBe("Weather MCP");
    expect(
      panel.querySelector<HTMLAnchorElement>('a[href$="docs/setup.md"]')?.href,
    ).toBe(`https://github.com/o/r/blob/${SHA}/mcp/docs/setup.md`);
    // The picture is not loaded: its alt text links to it.
    expect(panel.querySelector("img")).toBeNull();
    const picture = panel.querySelector<HTMLAnchorElement>(
      'a[href$="img/arch.png"]',
    )!;
    expect(picture.href).toBe(
      `https://raw.githubusercontent.com/o/r/${SHA}/mcp/img/arch.png`,
    );
    expect(picture.textContent).toBe("[Architecture]");
    expect(picture.rel).toBe("nofollow ugc noopener noreferrer");
    expect(panel.textContent).toContain(
      "Source: mcp/README.md at commit 0123456",
    );
  });

  it("lists the tools on their tab", async () => {
    await open(readme("ok"));
    await select("Tools (2)");
    const panel = activePanel();
    expect(
      [...panel.querySelectorAll("li")].map(
        (node) => node.querySelector("span")?.textContent,
      ),
    ).toEqual(["forecast", "alerts"]);
    expect(panel.textContent).toContain("Daily forecast.");
  });

  it("explains a README that is missing or too large", async () => {
    await open(readme("not_found", { source: null }));
    await select("README");
    expect(activePanel().textContent).toBe("This repository has no README.");
    await unmountAll();

    await open(readme("too_large"));
    await select("README");
    const link = activePanel().querySelector<HTMLAnchorElement>("a")!;
    expect(link.textContent).toBe("open it on GitHub");
    expect(link.href).toBe(`https://github.com/o/r/blob/${SHA}/mcp/README.md`);
  });

  it("points to the repository when the README could not be read", async () => {
    for (const status of [
      "error",
      "unsupported_host",
    ] satisfies McpReadmeStatus[]) {
      await open(readme(status));
      await select("README");
      const link = activePanel().querySelector<HTMLAnchorElement>("a")!;
      expect(link.textContent).toBe("Read the README in its repository");
      expect(link.href).toBe("https://github.com/o/r");
      await unmountAll();
    }
  });

  it("hides the README tab while pending, without a README, or with nothing to show", async () => {
    for (const value of [
      readme("pending"),
      null,
      undefined,
      readme("ok", { markdown: "" }),
      readme("error", { source: null }),
    ]) {
      await open(value);
      expect(tabs().map((node) => node.textContent)).toEqual([
        "Overview",
        "Tools (2)",
      ]);
      await unmountAll();
    }
  });
});
