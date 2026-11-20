import { expect, test } from "vitest";
import { getAgentToolDefinition } from "@sourceweft/agent-tool-registry";
import { registerBuiltinAgentTools } from "./register-builtin-agent-tools";

// vitest.setup.ts already calls this once before any test file runs; calling
// it again here is a no-op (registerAgentTools skips names it has already
// seen) and keeps this test self-contained if it is ever run without that
// setup file.
registerBuiltinAgentTools();

test("jira agent tools are registered in the web registry", () => {
  for (const name of [
    "search_jira_issues",
    "read_jira_issue",
    "list_jira_projects",
  ]) {
    expect(getAgentToolDefinition(name), name).not.toBeNull();
  }
});

test("confluence agent tools are registered in the web registry", () => {
  for (const name of [
    "search_confluence",
    "read_confluence_page",
    "list_confluence_spaces",
  ]) {
    expect(getAgentToolDefinition(name), name).not.toBeNull();
  }
});
