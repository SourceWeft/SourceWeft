import assert from "node:assert/strict";
import { test } from "vitest";
import { createTranslator } from "next-intl";
import type { useTranslations } from "next-intl";
import en from "../../../../../messages/en.json";
import zhCN from "../../../../../messages/zh-CN.json";
import zhTW from "../../../../../messages/zh-TW.json";
import {
  getToolActivityCategory,
  summarizeToolGroup,
} from "./tool-group-summary";
import { resolveToolCallsFromMetadata } from "../../[threadId]/_thread/message-normalizers";
import type { ToolCallRecord } from "./types";

type Translate = ReturnType<typeof useTranslations>;

const catalogs = { en, "zh-CN": zhCN, "zh-TW": zhTW } as const;

function translator(locale: keyof typeof catalogs) {
  return createTranslator({
    locale,
    messages: catalogs[locale],
    namespace: "dashboardChatCanvas",
  }) as unknown as Translate;
}

let nextId = 0;
function call(
  tool: string,
  input: Record<string, unknown> = {},
): ToolCallRecord {
  nextId += 1;
  return {
    error: null,
    id: `call-${nextId}`,
    input,
    latencyMs: 10,
    output: null,
    status: "completed",
    tool,
  };
}

function summarize(
  toolCalls: ToolCallRecord[],
  locale: keyof typeof catalogs = "en",
) {
  return summarizeToolGroup({ locale, t: translator(locale), toolCalls });
}

test("mixed categories keep first-seen order with their own verbs", () => {
  assert.equal(
    summarize([
      call("search_gmail_messages"),
      call("read_file", { file_path: "/a.ts" }),
      call("read_file", { file_path: "/b.ts" }),
      call("execute", { command: "pwd" }),
    ]),
    "Used Gmail, read 2 files, and ran a command",
  );
});

test("repeated categories are counted once", () => {
  assert.equal(
    summarize([
      call("execute"),
      call("execute"),
      call("execute"),
      call("execute"),
    ]),
    "Ran 4 commands",
  );
});

test("files are counted by distinct path", () => {
  assert.equal(
    summarize([
      call("read_file", { file_path: "/a.ts" }),
      call("read_file", { file_path: "/a.ts" }),
      call("edit_file", { file_path: "/a.ts" }),
      call("write_file", { path: "/b.ts" }),
    ]),
    "Read a file and edited 2 files",
  );
  assert.equal(
    summarize([call("read_file"), call("ls")]),
    "Read files and searched files",
  );
});

test("more than three categories collapse into a count", () => {
  assert.equal(
    summarize([
      call("web_search"),
      call("search_sources"),
      call("execute"),
      call("search_notion_pages"),
      call("search_gmail_messages"),
    ]),
    "Searched the web, searched your sources, ran a command, and 2 more",
  );
});

test("connectors of the same type merge, different types stay apart", () => {
  assert.equal(
    summarize([
      call("search_gmail_messages"),
      call("get_gmail_thread"),
      call("read_notion_page"),
    ]),
    "Used Gmail and used Notion",
  );
});

test("unknown and MCP tools are named by the tool itself", () => {
  assert.deepEqual(
    getToolActivityCategory(call("mcp__io_github_x_1a2b__list_issues")),
    {
      key: "tool:List Issues",
      kind: "tool",
      name: "List Issues",
    },
  );
  assert.equal(
    summarize([call("custom_thing"), call("custom_thing")]),
    "Used Custom Thing",
  );
});

test("empty input yields an empty summary", () => {
  assert.equal(summarize([]), "");
});

test("summaries are localized", () => {
  const calls = [
    call("search_gmail_messages"),
    call("read_file", { file_path: "/a.ts" }),
    call("read_file", { file_path: "/b.ts" }),
    call("read_file", { file_path: "/c.ts" }),
    call("execute"),
  ];
  assert.equal(
    summarize(calls, "zh-CN"),
    "使用了 Gmail、读取了 3 个文件和运行了 1 条命令",
  );
  assert.equal(
    summarize(calls, "zh-TW"),
    "使用了 Gmail、讀取了 3 個檔案和執行了 1 條命令",
  );
  assert.equal(
    summarize(
      [call("web_search"), call("search_sources"), call("execute"), call("ls")],
      "zh-CN",
    ),
    "搜索了网页、检索了资料源、运行了 1 条命令和其他 1 项",
  );
});

test("MCP summaries retain full display metadata in all locales and after reload", () => {
  const toolCall = {
    ...call("mcp__anycrawl_abcd1234__sea_7890abcd"),
    mcpDisplay: {
      serverName: "AnyCrawl",
      toolName: "搜索网页与完整文章 Search full articles",
    },
  };
  for (const locale of ["en", "zh-CN", "zh-TW"] as const) {
    const summary = summarizeToolGroup({
      locale,
      t: translator(locale),
      toolCalls: [JSON.parse(JSON.stringify(toolCall))],
    });
    assert.ok(
      summary.includes("AnyCrawl · 搜索网页与完整文章 Search full articles"),
    );
    assert.ok(!summary.includes("7890abcd"));
  }
});

test("actual Microsoft Learn persisted search and fetch summaries exclude execution aliases in every locale", () => {
  const entries = [
    ["search", "9eda69db"],
    ["fetch", "69f82065"],
  ];
  const toolCalls = entries.map(([name, hash]) => ({
    ...call(`mcp__com_microsoft_microsoft-learn-mc_371294fd__microso_${hash}`),
    id: name,
    status: "completed",
  }));
  const metadata = JSON.parse(
    JSON.stringify({
      toolCalls,
      traceEvents: entries.map(([name], index) => ({
        toolCall: {
          id: name,
          tool: toolCalls[index]?.tool,
          mcpDisplay: {
            serverName: "Microsoft Learn MCP",
            toolName: `microsoft_docs_${name}`,
          },
        },
      })),
    }),
  );
  for (const locale of ["en", "zh-CN", "zh-TW"] as const) {
    const summary = summarizeToolGroup({
      locale,
      t: translator(locale),
      toolCalls: resolveToolCallsFromMetadata(metadata),
    });
    assert.ok(summary.includes("Microsoft Learn MCP · microsoft_docs_search"));
    assert.ok(summary.includes("Microsoft Learn MCP · microsoft_docs_fetch"));
    assert.ok(!summary.includes("9eda69db"));
    assert.ok(!summary.includes("69f82065"));
  }
});
