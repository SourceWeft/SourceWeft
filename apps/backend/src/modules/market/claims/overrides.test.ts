import { describe, expect, test } from "vitest";
import {
  marketItemSummarySchema,
  marketMcpManifestSchema,
  type MarketItemSummary,
} from "@sourceweft/market-contracts";
import {
  applyOwnerOverridesToItem,
  applyOwnerOverridesToManifest,
  clearAuthoredBy,
  effectiveOwnerOverrides,
  mergeAuthoredFields,
  ownerLayerOf,
  ownerSubmittedTools,
  visibleOwnerOverrides,
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

  test("the owner's license and language replace the resolved ones, in item and manifest", () => {
    const licensed = {
      overridesJson: { license: " Apache-2.0 ", language: "Rust" },
      toolsJson: null,
      toolsSubmittedAt: null,
      updatedAt: new Date(0),
    };
    const base = { ...federatedItem, license: "MIT", language: "Go" };
    const item = applyOwnerOverridesToItem(base, { row: licensed, claimed: true });
    expect([item.license, item.language]).toEqual(["Apache-2.0", "Rust"]);
    expect(item.owner?.fields).toEqual(["license", "language"]);
    const manifest = applyOwnerOverridesToManifest(federatedManifest, licensed);
    expect([manifest.license, manifest.language]).toEqual(["Apache-2.0", "Rust"]);
    // Without them the resolved values stay.
    const plain = applyOwnerOverridesToItem(base, {
      row: { ...licensed, overridesJson: {} },
      claimed: true,
    });
    expect([plain.license, plain.language]).toEqual(["MIT", "Go"]);
  });

  test("an owner's own summary drops the translation made from the registry's", () => {
    const translated = {
      ...federatedItem,
      descriptionLanguage: "en",
      localizedSummary: { locale: "zh-CN" as const, text: "注册表摘要" },
    };
    const owned = (overridesJson: Record<string, unknown>) =>
      applyOwnerOverridesToItem(translated, {
        row: { overridesJson, toolsJson: null, toolsSubmittedAt: null, updatedAt: new Date(0) },
        claimed: true,
      });
    expect(owned({ summary: "Owner summary" })).toMatchObject({
      descriptionLanguage: null,
      localizedSummary: null,
    });
    expect(owned({ homepageUrl: "https://notion.com" }).localizedSummary).toEqual({
      locale: "zh-CN",
      text: "注册表摘要",
    });
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

describe("field authorship", () => {
  const stored = (extra: Partial<McpOwnerOverridesSource> = {}): McpOwnerOverridesSource => ({
    overridesJson: { iconUrl: "https://a.example/a.png", summary: "B summary" },
    authorsJson: { iconUrl: "a", summary: "b", tools: "b" },
    toolsJson: [{ name: "b_tool" }],
    toolsSubmittedAt: "2026-10-20T00:00:00.000Z",
    updatedAt: "2026-10-21T00:00:00.000Z",
    ...extra,
  });

  test("a field shows only while its author holds a verified claim", () => {
    const both = visibleOwnerOverrides(stored(), new Set(["a", "b"]));
    expect(both?.overridesJson).toEqual({
      iconUrl: "https://a.example/a.png",
      summary: "B summary",
    });
    expect(both?.toolsJson).toEqual([{ name: "b_tool" }]);

    const onlyA = visibleOwnerOverrides(stored(), new Set(["a"]));
    expect(onlyA?.overridesJson).toEqual({ iconUrl: "https://a.example/a.png" });
    expect(onlyA?.toolsJson).toBeNull();
    expect(onlyA?.toolsSubmittedAt).toBeNull();

    expect(visibleOwnerOverrides(stored(), new Set())).toBeNull();
    // A field nobody is recorded as having written is not shown.
    expect(
      visibleOwnerOverrides(stored({ authorsJson: {} }), new Set(["a", "b"]))?.overridesJson,
    ).toEqual({});
  });

  test("a raw row carries its verified members, and is filtered the same way", () => {
    const raw = stored({ verifiedUsers: ["a"] });
    expect(effectiveOwnerOverrides(raw)?.overridesJson).toEqual({
      iconUrl: "https://a.example/a.png",
    });
    expect(effectiveOwnerOverrides(stored({ verifiedUsers: [] }))).toBeNull();
    expect(effectiveOwnerOverrides(null)).toBeNull();
  });

  test("fails closed: without the verified members nothing is visible", () => {
    // A row that did not come with who holds a claim is never shown whole.
    expect(effectiveOwnerOverrides(stored())).toBeNull();
    expect(effectiveOwnerOverrides(stored({ verifiedUsers: null }))).toBeNull();
  });

  test("a save keeps the author of what it left alone and takes what it changed", () => {
    const merged = mergeAuthoredFields({
      previousValues: { iconUrl: "https://a.example/a.png", summary: "old" },
      previousAuthors: { iconUrl: "a", summary: "a", tools: "a" },
      next: { iconUrl: "https://a.example/a.png", summary: "new", homepageUrl: "https://h.example" },
      userId: "b",
      verified: new Set(["a", "b"]),
    });
    expect(merged.values).toEqual({
      iconUrl: "https://a.example/a.png",
      summary: "new",
      homepageUrl: "https://h.example",
    });
    expect(merged.authors).toEqual({
      iconUrl: "a",
      summary: "b",
      homepageUrl: "b",
      tools: "a",
    });
  });

  test("a save drops the visible fields it no longer sends, and spares hidden ones", () => {
    const merged = mergeAuthoredFields({
      previousValues: { iconUrl: "https://a.example/a.png", summary: "from c" },
      previousAuthors: { iconUrl: "a", summary: "c" },
      next: {},
      userId: "a",
      verified: new Set(["a"]),
    });
    // a's own icon is cleared by a's save; c (no claim now) keeps theirs.
    expect(merged.values).toEqual({ summary: "from c" });
    expect(merged.authors).toEqual({ summary: "c" });
  });

  test("writing a hidden field's value yourself makes it yours", () => {
    const merged = mergeAuthoredFields({
      previousValues: { summary: "same" },
      previousAuthors: { summary: "c" },
      next: { summary: "same" },
      userId: "a",
      verified: new Set(["a"]),
    });
    expect(merged.authors).toEqual({ summary: "a" });
  });

  test("blocking a member clears the fields and the tool list they wrote", () => {
    expect(clearAuthoredBy(stored(), "b")).toEqual({
      overridesJson: { iconUrl: "https://a.example/a.png" },
      authorsJson: { iconUrl: "a" },
      clearTools: true,
    });
    expect(clearAuthoredBy(stored(), "a")).toEqual({
      overridesJson: { summary: "B summary" },
      authorsJson: { summary: "b", tools: "b" },
      clearTools: false,
    });
    expect(clearAuthoredBy(stored(), "nobody")).toBeNull();
  });
});
