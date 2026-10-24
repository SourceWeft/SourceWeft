import {
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { marketItemSummarySchema } from "@sourceweft/market-contracts";

import enMessages from "../../../../messages/en.json";

// next-intl reads its request config through the Next plugin, which a unit
// test does not have: serve the English catalog directly instead.
vi.mock("next-intl/server", async () => {
  const { createTranslator } = await import("next-intl");
  const messages = (await import("../../../../messages/en.json")).default;
  return {
    getTranslations: async (namespace?: string) =>
      createTranslator({
        locale: "en",
        messages,
        namespace: namespace as never,
      }),
  };
});
vi.mock("next-intl", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next-intl")>()),
  useLocale: () => "en",
}));

import { McpMarketCard } from "./mcp-display";

/**
 * Awaits the async server components in a tree (the card and its badges) the
 * way the server would, so the result can be rendered to markup.
 */
async function resolveServerTree(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) {
    return Promise.all(node.map((child) => resolveServerTree(child)));
  }
  if (!isValidElement(node)) return node;
  const element = node as ReactElement<{ children?: ReactNode }>;
  if (
    typeof element.type === "function" &&
    element.type.constructor.name === "AsyncFunction"
  ) {
    const render = element.type as (props: unknown) => Promise<ReactNode>;
    return resolveServerTree(await render(element.props));
  }
  if (element.props.children === undefined) return element;
  return cloneElement(
    element,
    undefined,
    await resolveServerTree(element.props.children),
  );
}

function item(patch: Record<string, unknown> = {}) {
  return marketItemSummarySchema.parse({
    createdAt: "2026-09-01T00:00:00.000Z",
    id: "mcp-1",
    identifier: "io.github.o/weather",
    name: "Weather",
    status: "published",
    summary: "Forecasts for any city.",
    updatedAt: "2026-09-15T00:00:00.000Z",
    visibility: "public",
    ...patch,
  });
}

async function card(value: ReturnType<typeof item>) {
  return renderToStaticMarkup(
    (await resolveServerTree(
      await McpMarketCard({ item: value }),
    )) as ReactElement,
  );
}

describe("public MCP card", () => {
  it("shows the AI summary when the market has one, marked as AI-written", async () => {
    const html = await card(
      item({ aiSummary: "Weather lookups for trip planning." }),
    );
    expect(html).toContain("Weather lookups for trip planning.");
    expect(html).not.toContain("Forecasts for any city.");
    expect(html).toContain("data-ai-summary");
    expect(html).toContain(
      `title="${enMessages.mcp.aiOverview.cardSummaryTitle}"`,
    );
  });

  it("falls back to the registry summary without one, where it is longer than the template", async () => {
    for (const aiSummary of [undefined, null, "  "]) {
      const html = await card(
        item({
          aiSummary,
          summary:
            "Forecasts for any city, with severe-weather alerts and air quality.",
        }),
      );
      expect(html).toContain(
        "Forecasts for any city, with severe-weather alerts and air quality.",
      );
      expect(html).not.toContain("data-ai-summary");
    }
  });

  // #367 W4: a registry summary no longer than the template sentence gives
  // way to it; a card has no endpoint, so the template names none.
  it("shows the template sentence when the registry summary says less", async () => {
    const html = await card(
      item({
        name: "Notion",
        summary: "Notion MCP Server",
        transport: "streamable_http",
        requiresAuth: true,
        toolsCount: 24,
      }),
    );
    expect(html).toContain(
      "Notion&#x27;s hosted MCP server; credential required; Streamable HTTP; 24 tools.",
    );
    expect(html).not.toContain("Notion MCP Server</p>");
    expect(html).not.toContain("data-ai-summary");
    const local = await card(
      item({
        name: "Filesystem",
        summary: "Files.",
        transport: "stdio",
        toolsCount: 0,
      }),
    );
    expect(local).toContain(
      "Filesystem&#x27;s local MCP server; no sign-in required; STDIO.",
    );
  });
});
