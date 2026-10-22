// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type MarketMcpReadme,
  type McpReadmeStatus,
  marketItemSummarySchema,
} from "@sourceweft/market-contracts";
import { workspaceMcpInstallSchema } from "@sourceweft/contracts";
import type { WorkspaceMcpInstall } from "@sourceweft/sdk";

import { mountWithIntl, unmountAll } from "@/test/react";

import { McpDetailDialog } from "./mcp-detail-dialog";

const api = vi.hoisted(() => ({ getWorkspaceMarketMcp: vi.fn() }));
vi.mock("../../../../lib/sdk", () => ({ contentClient: api }));

const SHA = "0123456789abcdef0123456789abcdef01234567";
const IDENTIFIER = "io.github.o/weather";

const SUMMARY = {
  createdAt: "2026-09-01T00:00:00.000Z",
  id: "mcp-1",
  identifier: IDENTIFIER,
  latestVersion: "1.0.0",
  name: "Weather",
  status: "published",
  summary: "Forecasts for any city.",
  toolsCount: 2,
  updatedAt: "2026-09-15T00:00:00.000Z",
  verified: true,
  visibility: "public",
};
const summary = marketItemSummarySchema.parse(SUMMARY);
/** A federated registry entry: the catalog publishes no tools. */
const federated = marketItemSummarySchema.parse({ ...SUMMARY, toolsCount: 0 });

/** A workspace install of the server with these synced tools. */
function installed(
  tools: Array<{
    name: string;
    title?: string;
    description?: string;
    risk?: string;
    enabled?: boolean;
  }>,
): WorkspaceMcpInstall {
  return workspaceMcpInstallSchema.parse({
    authType: "none",
    createdAt: "2026-09-01T00:00:00.000Z",
    createdBy: null,
    credentialStatus: "not_required",
    desktopOnly: false,
    enabled: true,
    endpointUrl: "https://mcp.example.com/mcp",
    id: "install-1",
    lastError: null,
    lastTestedAt: null,
    manifestJson: {
      identifier: IDENTIFIER,
      name: "Weather",
      schemaVersion: 1,
      summary: "Forecasts for any city.",
      transport: "streamable_http",
      version: "1.0.0",
    },
    marketIdentifier: IDENTIFIER,
    marketVersion: "1.0.0",
    name: "Weather",
    official: false,
    signature: null,
    signingKeyId: null,
    source: "market",
    status: "active",
    summary: "Forecasts for any city.",
    teamId: "team-1",
    tools: tools.map((tool, index) => ({
      annotations: {},
      createdAt: "2026-09-01T00:00:00.000Z",
      description: tool.description ?? null,
      enabled: tool.enabled ?? true,
      id: `tool-${index}`,
      inputSchema: {},
      installId: "install-1",
      lastDiscoveredHash: null,
      normalizedToolName: tool.name,
      outputSchema: null,
      risk: tool.risk ?? "unknown",
      serverToolName: tool.name,
      title: tool.title ?? null,
      updatedAt: "2026-09-01T00:00:00.000Z",
    })),
    transport: "streamable_http",
    updatedAt: "2026-09-01T00:00:00.000Z",
    verified: true,
    webExecutable: true,
    workspaceId: "ws-1",
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
function detail(
  value?: MarketMcpReadme | null,
  {
    install = null,
    item = summary,
    catalogTools = [
      { description: "Daily forecast.", name: "forecast", risk: "read" },
      { name: "alerts", risk: "read" },
    ],
  }: {
    install?: WorkspaceMcpInstall | null;
    item?: typeof summary;
    catalogTools?: Array<Record<string, unknown>>;
  } = {},
) {
  return {
    install,
    market: {
      item,
      ...(value === undefined ? {} : { readme: value }),
      versions: [
        {
          manifestJson: {
            description: "Forecasts and alerts for any city.",
            identifier: IDENTIFIER,
            name: "Weather",
            schemaVersion: 1,
            summary: "Forecasts for any city.",
            tools: catalogTools,
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

async function open(
  value?: MarketMcpReadme | null,
  options: Parameters<typeof detail>[1] = {},
) {
  const loaded = detail(value, options);
  api.getWorkspaceMarketMcp.mockResolvedValue(loaded);
  await mountWithIntl(
    <McpDetailDialog
      item={{ install: loaded.install, market: loaded.market.item }}
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

function field(label: string) {
  const term = [...document.querySelectorAll("dt")].find(
    (node) => node.textContent === label,
  );
  if (!term) throw new Error(`No field named ${label}`);
  return term.nextElementSibling as HTMLElement;
}

function toolNames() {
  return [...activePanel().querySelectorAll("li")].map(
    (node) => node.querySelector("span")?.textContent,
  );
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
    expect(api.getWorkspaceMarketMcp).toHaveBeenCalledWith(
      "ws-1",
      IDENTIFIER,
      { locale: "en" },
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

  it("puts the Runtime & security heading on its own line above its text", async () => {
    await open(readme("ok"));
    const heading = [...document.querySelectorAll("h2")].find(
      (node) => node.textContent === "Runtime & security",
    )!;
    // A block heading: an inline one let the text run on after it.
    expect(heading.classList.contains("flex")).toBe(true);
    expect(heading.classList.contains("inline-flex")).toBe(false);
    const body = heading.nextElementSibling!;
    expect(body.tagName).toBe("P");
    expect(body.textContent).toBe(
      "Credentials are encrypted per workspace and sent only to this server during tool calls.",
    );
    expect(heading.parentElement!.textContent).toBe(
      `${heading.textContent}${body.textContent}`,
    );
  });
});

describe("McpDetailDialog tools and server details", { timeout: 30_000 }, () => {
  it("counts and lists the install's synced tools when the catalog has none", async () => {
    await open(null, {
      catalogTools: [],
      install: installed([
        {
          description: "Search the workspace.",
          name: "notion-search",
          risk: "read",
          title: "Search",
        },
        { name: "notion-create-pages", risk: "write" },
        { enabled: false, name: "notion-delete-page", risk: "destructive" },
      ]),
      item: federated,
    });
    expect(activePanel().textContent).toContain("3 tools synced");
    expect(tabs().map((node) => node.textContent)).toEqual([
      "Overview",
      "Tools (3)",
    ]);
    expect(field("Tools").textContent).toBe("3");

    await select("Tools (3)");
    const panel = activePanel();
    expect(toolNames()).toEqual([
      "Search",
      "notion-create-pages",
      "notion-delete-page",
    ]);
    expect(panel.textContent).toContain("Search the workspace.");
    expect(panel.textContent).not.toContain("Tool details are published");
    const items = [...panel.querySelectorAll("li")];
    expect(items[1]!.textContent).not.toContain("Disabled");
    expect(items[2]!.textContent).toContain("Disabled");
    expect(items[2]!.textContent).toContain("Destructive");
  });

  it("keeps the catalog's tools until the install has synced any", async () => {
    await open(null, { install: installed([]) });
    expect(field("Tools").textContent).toBe("2");
    await select("Tools (2)");
    expect(toolNames()).toEqual(["forecast", "alerts"]);
  });

  it("says tools are pending only when neither the catalog nor an install has any", async () => {
    await open(null, { catalogTools: [], item: federated });
    expect(field("Tools").textContent).toBe("0");
    await select("Tools (0)");
    expect(activePanel().textContent).toBe(
      "Tool details are published after the server is indexed or installed.",
    );
  });

  it("shows server details as written, with readable transport and runtime", async () => {
    await open(null, {
      item: marketItemSummarySchema.parse({
        ...SUMMARY,
        identifier: "io.github.Arcmira/arcmira",
      }),
    });
    for (const node of document.querySelectorAll("dd")) {
      expect(node.classList.contains("capitalize")).toBe(false);
    }
    expect(field("Identifier").textContent).toBe("io.github.Arcmira/arcmira");
    expect(field("Transport").textContent).toBe("Streamable HTTP");
    expect(field("Runtime").textContent).toBe("Web executable");
    await unmountAll();

    await open(null, {
      item: marketItemSummarySchema.parse({ ...SUMMARY, runtime: "desktop" }),
    });
    expect(field("Runtime").textContent).toBe("Desktop only");
  });
});
