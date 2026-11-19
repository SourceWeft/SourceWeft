import assert from "node:assert/strict";
import { test } from "vitest";
import {
  AGENT_TOOLS,
  AGENT_TOOL_NAMES,
  getAgentToolDefinition,
} from "@sourceweft/agent-tool-registry";
import { config } from "../../../shared/config";
import {
  createSourceWeftAgentMiddlewareStack,
  createSourceWeftSubagentMiddlewareStack,
} from "./middleware";
import {
  SCHEDULED_RUN_PROMPT,
  UNATTENDED_FILESYSTEM_PERMISSIONS,
  UNATTENDED_TOOL_ALLOWLIST,
  applyUnattendedToolPolicy,
  filterToolsForUnattendedRun,
  unattendedFilesystemMiddleware,
} from "./unattended-policy";

const named = (...names: string[]) => names.map((name) => ({ name }));
const noGates = { gatedToolNames: new Set<string>() };

test("the allow-list holds only registered, low-risk tools outside the sandbox", () => {
  assert.deepEqual([...UNATTENDED_TOOL_ALLOWLIST].sort(), [
    "read_document",
    "search_files",
    "search_sources",
    "view_image",
    "web_fetch",
    "web_search",
  ]);
  for (const name of UNATTENDED_TOOL_ALLOWLIST) {
    const definition = getAgentToolDefinition(name);
    assert.ok(definition, `${name} is a registered tool`);
    assert.equal(definition.riskLevel, "low", name);
    assert.notEqual(definition.domain, "sandbox", name);
    assert.notEqual(definition.domain, "interaction", name);
  }
});

test("every registry tool that is not allow-listed is denied, whatever the turn allowed before", () => {
  const permissions = applyUnattendedToolPolicy({
    [AGENT_TOOL_NAMES.execute]: "allow",
    [AGENT_TOOL_NAMES.publishArtifact]: "allow",
    [AGENT_TOOL_NAMES.searchSources]: "allow",
    [AGENT_TOOL_NAMES.webSearch]: "deny",
    create_notion_page: "ask",
  });
  for (const tool of AGENT_TOOLS) {
    if (UNATTENDED_TOOL_ALLOWLIST.has(tool.name)) continue;
    assert.equal(permissions[tool.name], "deny", tool.name);
  }
  // Write-class, sandbox and interaction tools by name, so a change to the
  // registry cannot quietly drop one of them from the loop above.
  for (const name of [
    "write_file",
    "edit_file",
    "publish_artifact",
    "generate_image",
    "execute",
    "prepare_sandbox_workspace",
    "collect_sandbox_outputs",
    "askUser",
  ]) {
    assert.equal(permissions[name], "deny", name);
  }
  // A tool the turn named that the registry does not know is denied too.
  assert.equal(permissions.create_notion_page, "deny");
  // The policy narrows; it never turns on what the turn had off.
  assert.equal(permissions[AGENT_TOOL_NAMES.searchSources], "allow");
  assert.equal(permissions[AGENT_TOOL_NAMES.webSearch], "deny");
});

test("only allow-listed tools and ungated MCP tools are bound", () => {
  const tools = named(
    "search_sources",
    "web_search",
    "read_document",
    // write-class
    "publish_artifact",
    "generate_image",
    "write_file",
    // sandbox
    "execute",
    // skills catalog, connector actions, anything unknown
    "search_skills",
    "install_skill",
    "enable_skill",
    "send_gmail_message",
    "search_notion_pages",
    "create_notion_page",
    "some_future_tool",
    "askUser",
    // MCP: one a verified install marks read-only, one that asks first
    "mcp__docs__search",
    "mcp__docs__delete_page",
  );
  assert.deepEqual(
    filterToolsForUnattendedRun(tools, {
      gatedToolNames: new Set(["mcp__docs__delete_page", "enable_skill"]),
    }).map((tool) => tool.name),
    ["search_sources", "web_search", "read_document", "mcp__docs__search"],
  );
});

test("a tool that would ask for approval is never bound, even an allow-listed one", () => {
  assert.deepEqual(
    filterToolsForUnattendedRun(named("search_sources", "web_search"), {
      gatedToolNames: new Set(["web_search"]),
    }).map((tool) => tool.name),
    ["search_sources"],
  );
  assert.deepEqual(
    filterToolsForUnattendedRun(named("search_sources"), noGates).length,
    1,
  );
});

test("the filesystem is read-only: read tools on a deny-write policy", () => {
  assert.deepEqual(UNATTENDED_FILESYSTEM_PERMISSIONS.at(-1), {
    operations: ["write"],
    paths: ["/**"],
    mode: "deny",
  });
  assert.ok(
    UNATTENDED_FILESYSTEM_PERMISSIONS.every(
      (rule) => !rule.operations.includes("write") || rule.mode === "deny",
    ),
  );
  const middleware = unattendedFilesystemMiddleware({} as never);
  const tools = (middleware.tools ?? []).map((tool) => String(tool.name));
  assert.deepEqual(tools.sort(), ["glob", "grep", "ls", "read_file"]);
});

test("askUser is left out of the root and the sub-agent stacks when nobody is present", async () => {
  const base = { backend: {} as never, model: {} as never };
  const names = (stack: Array<{ name: string }>) =>
    stack.map((middleware) => middleware.name);
  const attended = names(
    await createSourceWeftAgentMiddlewareStack({
      ...base,
      modelAlias: "chat-default",
      filesystemMounts: [],
    }),
  );
  const unattended = names(
    await createSourceWeftAgentMiddlewareStack({
      ...base,
      modelAlias: "chat-default",
      filesystemMounts: [],
      askUser: false,
    }),
  );
  const child = names(
    createSourceWeftSubagentMiddlewareStack({ ...base, askUser: false }),
  );
  assert.equal(
    attended.includes("SourceWeftAskUser"),
    config.chat.agent.askUserEnabled,
  );
  for (const stack of [unattended, child]) {
    assert.equal(stack.includes("SourceWeftAskUser"), false);
    assert.equal(stack.includes("ToolCallLimitMiddleware[askUser]"), false);
  }
  // Nothing else is dropped with it.
  assert.deepEqual(
    attended.filter((name) => !name.includes("skUser")),
    unattended,
  );
});

test("the scheduled-run prompt tells the model nobody is there", () => {
  assert.ok(SCHEDULED_RUN_PROMPT.startsWith("<scheduled_run>"));
  assert.ok(SCHEDULED_RUN_PROMPT.endsWith("</scheduled_run>"));
  assert.match(SCHEDULED_RUN_PROMPT, /nobody is present/);
  assert.match(SCHEDULED_RUN_PROMPT, /Do not ask questions/);
});
