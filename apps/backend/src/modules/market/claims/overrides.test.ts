import { describe, expect, test } from "vitest";
import {
  marketItemSummarySchema,
  marketMcpManifestSchema,
  type MarketItemSummary,
} from "@sourceweft/market-contracts";
import {
  applyOwnerOverridesToItem,
  applyOwnerOverridesToManifest,
  ownerLayerOf,
  ownerSubmittedTools,
  type McpOwnerOverridesSource,
} from "./overrides";

const federatedItem: MarketItemSummary = marketItemSummarySchema.parse({
  id: "mcp-1",
  identifier: "com.notion/mcp",
  name: "Notion",
  summary: "Registry summary",
  iconUrl: "https://registry.example/icon.png",
  homepageUrl: "https://registry.example/home",
  repoUrl: null,
  status: "published",
  visibility: "public",
  toolsCount: 0,
  toolsValidation: { status: "failed", reason: "start", at: "2026-10-01T00:00:00Z" },
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-15T00:00:00.000Z",
});

const federatedManifest = marketMcpManifestSchema.parse({
  schemaVersion: 1,
  identifier: "com.notion/mcp",
  version: "1.0.0",
  name: "Notion",
  summary: "Registry summary",
  description: "Registry description",
  homepageUrl: "https://registry.example/home",
  transport: "streamable_http",
  endpointUrl: "https://mcp.notion.com/mcp",
  tools: [{ name: "probe_tool", risk: "read" }],
});

const row: McpOwnerOverridesSource = {
  overridesJson: {
    iconUrl: "https://notion.com/logo.png",
    summary: "Owner summary",
    description: "Owner long description",
    documentationUrl: "https://developers.notion.com/docs/mcp",
    homepageUrl: "https://notion.com",
    repoUrl: "https://github.com/makenotion/notion-mcp-server",
    deprecated: true,
  },
  toolsJson: [
    { name: "search", description: "Search pages", inputSchema: { type: "object" } },
    { name: "search", description: "duplicate, dropped" },
    { name: "create_page", annotations: { readOnlyHint: true } },
    { bogus: true },
  ],
  toolsSubmittedAt: "2026-10-20T00:00:00.000Z",
  updatedAt: new Date("2026-10-21T00:00:00.000Z"),
};

describe("owner layer", () => {
  test("owner values take precedence over the federated item", () => {
    const item = applyOwnerOverridesToItem(federatedItem, { row, claimed: true });
    expect(item.iconUrl).toBe("https://notion.com/logo.png");
    expect(item.iconSource).toBe("owner");
    expect(item.summary).toBe("Owner summary");
    expect(item.homepageUrl).toBe("https://notion.com");
    expect(item.repoUrl).toBe("https://github.com/makenotion/notion-mcp-server");
    expect(item.toolsCount).toBe(2);
    expect(item.toolsValidation).toBeNull();
    expect(item.claimed).toBe(true);
    expect(item.deprecated).toBe(true);
    expect(item.owner).toMatchObject({
      source: "owner",
      documentationUrl: "https://developers.notion.com/docs/mcp",
      deprecated: true,
      toolsSubmittedAt: "2026-10-20T00:00:00.000Z",
      updatedAt: "2026-10-21T00:00:00.000Z",
    });
    expect(item.owner?.fields).toEqual([
      "iconUrl",
      "summary",
      "description",
      "documentationUrl",
      "homepageUrl",
      "repoUrl",
      "deprecated",
      "tools",
    ]);
    // Still a valid public item.
    expect(marketItemSummarySchema.parse(item)).toBeTruthy();
  });

  test("a claimed server with no corrections shows the federated data and the mark", () => {
    const item = applyOwnerOverridesToItem(federatedItem, { row: null, claimed: true });
    expect(item).toMatchObject({
      ...federatedItem,
      claimed: true,
      deprecated: false,
      owner: null,
    });
  });

  test("blank or invalid stored values do not override", () => {
    const item = applyOwnerOverridesToItem(federatedItem, {
      row: {
        overridesJson: { summary: "   ", iconUrl: "not a url", homepageUrl: null },
        toolsJson: null,
        toolsSubmittedAt: null,
        updatedAt: new Date(0),
      },
      claimed: true,
    });
    expect(item.summary).toBe("Registry summary");
    expect(item.iconUrl).toBe("https://registry.example/icon.png");
    expect(item.homepageUrl).toBe("https://registry.example/home");
    expect(item.owner?.fields).toEqual([]);
  });

  test("stored links that are not https are dropped, never rendered", () => {
    const item = applyOwnerOverridesToItem(federatedItem, {
      row: {
        overridesJson: {
          iconUrl: "javascript:alert(1)",
          homepageUrl: "data:text/html,hi",
          repoUrl: "http://github.com/x/y",
          documentationUrl: "https://u:p@docs.example/",
          summary: "kept",
        },
        toolsJson: null,
        toolsSubmittedAt: null,
        updatedAt: new Date(0),
      },
      claimed: true,
    });
    expect(item.iconUrl).toBe("https://registry.example/icon.png");
    expect(item.homepageUrl).toBe("https://registry.example/home");
    expect(item.repoUrl).toBeNull();
    expect(item.owner?.documentationUrl).toBeNull();
    expect(item.summary).toBe("kept");
    expect(item.owner?.fields).toEqual(["summary"]);
  });

  test("the manifest gains the owner's fields, tools and the source record", () => {
    const layered = applyOwnerOverridesToManifest(federatedManifest, row);
    const manifest = marketMcpManifestSchema.parse(layered);
    expect(manifest.description).toBe("Owner long description");
    expect(manifest.summary).toBe("Owner summary");
    expect(manifest.documentationUrl).toBe("https://developers.notion.com/docs/mcp");
    expect(manifest.repoUrl).toBe("https://github.com/makenotion/notion-mcp-server");
    expect(manifest.owner).toMatchObject({ source: "owner", deprecated: true });
    expect(manifest.tools.map((tool) => tool.name)).toEqual(["search", "create_page"]);
    // Untouched: the registry's identity and transport facts.
    expect(manifest.identifier).toBe("com.notion/mcp");
    expect(manifest.endpointUrl).toBe("https://mcp.notion.com/mcp");
    expect(applyOwnerOverridesToManifest(federatedManifest, null)).toBe(federatedManifest);
  });

  test("owner-submitted tools are never trusted for unattended execution", () => {
    const tools = ownerSubmittedTools([
      { name: "delete_everything", annotations: { readOnlyHint: true }, risk: "read" },
      { name: "read_page", description: "x", risk: "read" },
    ]);
    expect(tools).toHaveLength(2);
    for (const tool of tools) {
      // Exactly like a probe-sourced tool: the HITL gate treats `unknown` as
      // high risk, whatever the submission or the server's hints claimed.
      expect(tool.risk).toBe("unknown");
      expect(tool.source).toBe("owner-submitted");
    }
    expect(tools[0]?.annotations).toEqual({ readOnlyHint: true });
    expect(ownerSubmittedTools(null)).toEqual([]);
    expect(ownerSubmittedTools("nope")).toEqual([]);
  });

  test("the layer record lists only the fields that are set", () => {
    const layer = ownerLayerOf({
      overridesJson: { deprecated: false, summary: "s" },
      toolsJson: [],
      toolsSubmittedAt: new Date("2026-10-20T00:00:00.000Z"),
      updatedAt: new Date("2026-10-21T00:00:00.000Z"),
    });
    expect(layer.fields).toEqual(["summary"]);
    expect(layer.deprecated).toBe(false);
    expect(layer.toolsSubmittedAt).toBeNull();
  });
});
