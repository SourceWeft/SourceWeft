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
vi.mock("next-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-intl")>();
  const messages = (await import("../../../../messages/en.json")).default;
  return {
    ...actual,
    useLocale: () => "en",
    useTranslations: (namespace?: string) =>
      actual.createTranslator({
        locale: "en",
        messages,
        namespace: namespace as never,
      }),
  };
});

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

  // Issue #367: the publisher's own server, next to the provider name.
  it("marks a server its publisher runs as from the official publisher", async () => {
    const html = await card(
      item({
        identifier: "com.notion/mcp",
        providerName: "com.notion",
        publisher: {
          domain: "notion.com",
          source: "registry-namespace",
          endpointMatch: true,
        },
      }),
    );
    expect(html).toContain('data-official-publisher="notion.com"');
    expect(html).toContain(enMessages.mcp.card.officialPublisher);
    expect(html).toContain(
      `title="Published by notion.com, which also runs this server&#x27;s endpoint."`,
    );
    // Not the manual "Official" verification badge.
    expect(html).not.toContain(`>${enMessages.mcp.badges.verification.official}<`);
  });

  it("shows no publisher mark when the endpoint is elsewhere or there is no publisher", async () => {
    for (const publisher of [
      undefined,
      null,
      {
        domain: "notion.com",
        source: "registry-namespace",
        endpointMatch: false,
      },
    ]) {
      const html = await card(item({ publisher }));
      expect(html).not.toContain("data-official-publisher");
      expect(html).not.toContain(enMessages.mcp.card.officialPublisher);
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

  // #367 A1: an io.github.* listing names a GitHub account the registry
  // checked, not the product's maker.
  it("labels a GitHub-namespace server neutrally and never as official", async () => {
    const html = await card(
      item({ identifier: "io.github.arcmira/mcp", providerName: "arcmira" }),
    );
    expect(html).toContain('data-github-account="arcmira"');
    expect(html).toContain("Published by GitHub account arcmira");
    expect(html).not.toContain("data-official-publisher");
    expect(html).not.toContain(enMessages.mcp.card.officialPublisher);
    // A verified claim changes nothing about who published it.
    const claimed = await card(
      item({
        claimed: true,
        identifier: "io.github.arcmira/mcp",
        providerName: "arcmira",
      }),
    );
    expect(claimed).toContain(enMessages.mcp.badges.claimed);
    expect(claimed).toContain("Published by GitHub account arcmira");
    expect(claimed).not.toContain("data-official-publisher");
  });

  it("keeps the provider name for a server with neither a domain nor a GitHub namespace", async () => {
    const html = await card(
      item({ identifier: "acme/weather", providerName: "Acme" }),
    );
    expect(html).toContain(">Acme<");
    expect(html).not.toContain("data-github-account");
  });

  it("leaves out the verification badge where the list asks", async () => {
    const value = item({ verified: true });
    const plain = renderToStaticMarkup(
      (await resolveServerTree(
        await McpMarketCard({ item: value }),
      )) as ReactElement,
    );
    expect(plain).toContain(enMessages.mcp.badges.verification.verified);
    const hidden = renderToStaticMarkup(
      (await resolveServerTree(
        await McpMarketCard({ hideVerification: true, item: value }),
      )) as ReactElement,
    );
    expect(hidden).not.toContain(enMessages.mcp.badges.verification.verified);
    expect(hidden).not.toContain(enMessages.mcp.badges.verification.unverified);
  });

  it("shows no 'Other' category as if it were one", async () => {
    expect(await card(item({ categories: ["other"] }))).not.toContain(
      ">Other<",
    );
    expect(await card(item({ categories: ["databases"] }))).toContain(
      ">Databases<",
    );
  });

  // Never "0 tools" for a list that is empty for another reason.
  it("says why a server lists no tools instead of 0 tools", async () => {
    const authRequired = await card(
      item({ requiresAuth: true, transport: "streamable_http" }),
    );
    expect(authRequired).toContain("Sign-in required");
    expect(authRequired).toContain('data-tools-status="authRequired"');
    expect(authRequired).not.toContain("0 tools");
    const unindexed = await card(item({ transport: "streamable_http" }));
    expect(unindexed).toContain("Not indexed yet");
    expect(unindexed).not.toContain("0 tools");
    const stdio = await card(item({ transport: "stdio" }));
    expect(stdio).toContain("Not validated yet");
    expect(stdio).not.toContain("0 tools");
    const failed = await card(
      item({
        toolsValidation: {
          at: "2026-10-20T00:00:00.000Z",
          reason: "start",
          status: "failed",
        },
        transport: "stdio",
      }),
    );
    expect(failed).toContain("Not validated · the server did not start");
    expect(await card(item({ toolsCount: 3 }))).toContain("3 tools");
  });
});
