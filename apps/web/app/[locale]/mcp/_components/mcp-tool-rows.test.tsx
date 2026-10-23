import {
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { marketMcpToolManifestSchema } from "@sourceweft/market-contracts";

const state = vi.hoisted(() => ({ locale: "en" }));

// next-intl reads its request config through the Next plugin, which a unit
// test does not have: serve the real catalog of the test's locale instead.
vi.mock("next-intl/server", async () => {
  const { createTranslator } = await import("next-intl");
  const catalogs = {
    en: (await import("../../../../messages/en.json")).default,
    "zh-CN": (await import("../../../../messages/zh-CN.json")).default,
    "zh-TW": (await import("../../../../messages/zh-TW.json")).default,
  };
  return {
    getTranslations: async (namespace?: string) =>
      createTranslator({
        locale: state.locale,
        messages: catalogs[state.locale as keyof typeof catalogs],
        namespace: namespace as never,
      }),
  };
});

import { McpToolRows } from "./mcp-display";

/** Awaits the async server components in a tree, as the server would. */
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

const tools = [
  {
    name: "search",
    description: "Search the index.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "integer" } },
      required: ["query"],
    },
    annotations: { title: "Search documents", readOnlyHint: true },
  },
  { name: "ping", inputSchema: { type: "object" } },
  {
    name: "wide",
    inputSchema: {
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 15 }, (_, index) => [`field_${index}`, {}]),
      ),
    },
    risk: "destructive",
  },
].map((tool) => marketMcpToolManifestSchema.parse(tool));

async function render(locale: string) {
  state.locale = locale;
  return renderToStaticMarkup(
    (await resolveServerTree(await McpToolRows({ tools }))) as ReactElement,
  );
}

describe("McpToolRows", () => {
  it("lists each tool with its description and parameters", async () => {
    const html = await render("en");
    expect(html).toContain('id="tool-search"');
    expect(html).toContain("Search documents");
    expect(html).toContain("Search the index.");
    expect(html).toMatch(
      /Parameters<\/span><code[^>]*>query<span[^>]*>required<\/span><\/code><code[^>]*>limit<\/code>/,
    );
    // Not the schema's own keys.
    expect(html).not.toContain(">properties<");
    expect(html).toContain("Takes no parameters.");
    expect(html).toContain(">field_11<");
    expect(html).not.toContain(">field_12<");
    expect(html).toContain("+3 more");
  });

  it("shows a risk only when the tool has a known one", async () => {
    const html = await render("en");
    expect(html).toContain(">Destructive<");
    expect(html).not.toContain(">Unknown<");
  });

  it.each([
    ["zh-CN", "输入参数", "必填", "无需输入参数。", "另有 3 个"],
    ["zh-TW", "輸入參數", "必填", "無需輸入參數。", "另有 3 個"],
  ])("localizes the parameter labels in %s", async (locale, ...labels) => {
    const html = await render(locale);
    for (const label of labels) expect(html).toContain(label);
    expect(html).not.toContain("Parameters");
  });
});
