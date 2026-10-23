import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";
import enMessages from "@/messages/en.json";
import zhCNMessages from "@/messages/zh-CN.json";
import zhTWMessages from "@/messages/zh-TW.json";

import {
  mcpTemplateDescription,
  type McpTemplateFacts,
} from "./mcp-template-description";

const catalogs = {
  en: enMessages,
  "zh-CN": zhCNMessages,
  "zh-TW": zhTWMessages,
} as const;

function translator(locale: keyof typeof catalogs) {
  const t = createTranslator({
    locale,
    messages: catalogs[locale],
    namespace: "mcp.template",
  });
  return (key: string, values?: Record<string, string | number>) =>
    t(key as never, values as never);
}

const notion: McpTemplateFacts = {
  name: "Notion",
  publisherDomain: "notion.com",
  endpointHost: "mcp.notion.com",
  transport: "streamable_http",
  authMethod: "oauth",
  toolCount: 0,
};

// #367 W4: the sentence is built from facts only; nothing is inferred.
describe("mcpTemplateDescription", () => {
  it("names the server, where it runs, its auth, transport and tools", () => {
    const t = translator("en");
    expect(mcpTemplateDescription(notion, t)).toBe(
      "Notion's hosted MCP server (mcp.notion.com), published by notion.com; OAuth sign-in required; Streamable HTTP.",
    );
    expect(mcpTemplateDescription({ ...notion, toolCount: 24 }, t)).toBe(
      "Notion's hosted MCP server (mcp.notion.com), published by notion.com; OAuth sign-in required; Streamable HTTP; 24 tools.",
    );
    expect(
      mcpTemplateDescription(
        {
          name: "Weather",
          endpointHost: "weather.example",
          transport: "streamable_http",
          authMethod: "notRequired",
          toolCount: 1,
        },
        t,
      ),
    ).toBe(
      "Weather's hosted MCP server (weather.example); no sign-in required; Streamable HTTP; 1 tool.",
    );
  });

  it("leaves out what is not known: publisher, host, transport, tools", () => {
    const t = translator("en");
    expect(
      mcpTemplateDescription(
        { name: "Exa", transport: "sse", authMethod: "optionalApiKey" },
        t,
      ),
    ).toBe("Exa's hosted MCP server; optional API key; SSE.");
    expect(
      mcpTemplateDescription(
        {
          name: "Exa",
          publisherDomain: "exa.ai",
          endpointHost: null,
          transport: null,
          authMethod: "apiKey",
          toolCount: null,
        },
        t,
      ),
    ).toBe("Exa's hosted MCP server, published by exa.ai; API key required.");
  });

  it("says a stdio server runs locally", () => {
    const t = translator("en");
    expect(
      mcpTemplateDescription(
        {
          name: "Filesystem",
          transport: "stdio",
          authMethod: "notRequired",
          toolCount: 11,
        },
        t,
      ),
    ).toBe(
      "Filesystem's local MCP server; no sign-in required; STDIO; 11 tools.",
    );
    expect(
      mcpTemplateDescription(
        {
          name: "Genesis402",
          publisherDomain: "unykorn.org",
          transport: "stdio",
          authMethod: "customHeaders",
        },
        t,
      ),
    ).toBe(
      "Genesis402's local MCP server, published by unykorn.org; custom request headers required; STDIO.",
    );
  });

  it("covers every auth method", () => {
    const t = translator("en");
    const phrases = (
      [
        "notRequired",
        "optionalApiKey",
        "required",
        "oauth",
        "oauthOrApiKey",
        "apiKey",
        "customHeaders",
      ] as const
    ).map(
      (authMethod) =>
        mcpTemplateDescription({ name: "X", authMethod }, t).split("; ")[1],
    );
    expect(phrases).toEqual([
      "no sign-in required.",
      "optional API key.",
      "credential required.",
      "OAuth sign-in required.",
      "OAuth sign-in or API key required.",
      "API key required.",
      "custom request headers required.",
    ]);
  });

  it("is localized, with the locale's own punctuation", () => {
    expect(
      mcpTemplateDescription({ ...notion, toolCount: 24 }, translator("zh-CN")),
    ).toBe(
      "Notion 的托管 MCP 服务（mcp.notion.com），由 notion.com 发布；需要 OAuth 登录；Streamable HTTP；24 个工具。",
    );
    expect(
      mcpTemplateDescription({ ...notion, toolCount: 24 }, translator("zh-TW")),
    ).toBe(
      "Notion 的託管 MCP 服務（mcp.notion.com），由 notion.com 發布；需要 OAuth 登入；Streamable HTTP；24 個工具。",
    );
    expect(
      mcpTemplateDescription(
        { name: "Filesystem", transport: "stdio", authMethod: "notRequired" },
        translator("zh-CN"),
      ),
    ).toBe("Filesystem 的本地 MCP 服务；无需登录；STDIO。");
  });
});
