import assert from "node:assert/strict";
import { test } from "vitest";
import { createBuiltinToolInvocationProvider } from "./builtin-tools";
import { createSkillCommandInvocationProvider } from "./skills";
import { createWorkspaceMcpInvocationProvider } from "./workspace-mcp";
import { createWorkspaceMcpManifestSnapshot, createWorkspaceMcpInstall } from "../mcp-install";

test("built-in tool provider projects selected tools as fixed tool choice", () => {
  const provider = createBuiltinToolInvocationProvider({
    tools: [
      { name: "generate_image", label: "Generate image", description: "Create images" },
      { name: "generate_pptx", label: "Generate presentation", description: "Create decks" },
    ],
  });

  const definitions = provider.list();
  assert.deepEqual(
    definitions.map((definition) => definition.id),
    ["builtin_tool.generate_image", "builtin_tool.generate_pptx"],
  );
  assert.equal(definitions[0]?.sourceRef.kind, "builtin_tool");
  assert.equal(definitions[0]?.semantics.kind, "fixed_tool_choice");
  assert.equal(definitions[0]?.semantics.kind === "fixed_tool_choice" ? definitions[0].semantics.target : null, "builtin_tool");
});

test("skill command provider projects commands as workflow context injection only", () => {
  const provider = createSkillCommandInvocationProvider({
    skills: [
      {
        workspaceSkillId: "skill_1",
        skillSlug: "research",
        displayName: "Research",
        commands: [
          {
            name: "summarize",
            title: "Summarize",
            description: "Summarize sources",
            workflow: "Read all selected sources, then summarize.",
          },
        ],
        enabled: true,
      },
    ],
  });

  const definition = provider.list()[0];
  assert.ok(definition);
  assert.equal(definition.id, "skill_command.research.summarize");
  assert.equal(definition.sourceRef.kind, "skill_command");
  assert.equal(definition.semantics.kind, "context_injection");
});

test("workspace MCP provider projects manifest tools, prompts, and resources distinctly", () => {
  const install = createWorkspaceMcpInstall({
    id: "mcp_install_1",
    workspaceId: "workspace_1",
    source: "marketplace",
    marketIdentifier: "github",
    transport: "streamable_http",
    endpointUrl: "https://mcp.example.com/mcp",
    manifest: createWorkspaceMcpManifestSnapshot({
      serverInstallId: "mcp_install_1",
      discoveredAt: "2026-01-01T00:00:00.000Z",
      schemaHash: "manifest_hash",
      tools: [
        {
          id: "tool_1",
          serverInstallId: "mcp_install_1",
          serverToolName: "create_issue",
          normalizedToolName: "github_create_issue",
          title: "Create issue",
          description: "Create an issue",
          inputSchema: { type: "object" },
          outputSchema: null,
          risk: "high",
          enabled: true,
          schemaHash: "tool_hash",
        },
      ],
      prompts: [
        {
          id: "prompt_1",
          serverInstallId: "mcp_install_1",
          name: "triage_issue",
          title: "Triage issue",
          description: "Triage an issue",
          argumentsSchema: null,
          enabled: true,
          schemaHash: "prompt_hash",
        },
      ],
      resources: [
        {
          id: "resource_1",
          serverInstallId: "mcp_install_1",
          uri: "github://issues/1",
          title: "Issue 1",
          description: "Issue resource",
          mimeType: "text/markdown",
          enabled: true,
          schemaHash: "resource_hash",
        },
      ],
    }),
  });
  const provider = createWorkspaceMcpInvocationProvider({ installs: [install] });
  const definitions = provider.list();

  assert.deepEqual(
    definitions.map((definition) => definition.sourceRef.kind),
    ["mcp_tool", "mcp_prompt", "mcp_resource"],
  );
  assert.equal(definitions[0]?.semantics.kind, "fixed_tool_choice");
  assert.equal(
    definitions[0]?.semantics.kind === "fixed_tool_choice"
      ? definitions[0].semantics.toolName
      : null,
    "mcp__github__github_create_issue",
  );
  assert.equal(definitions[1]?.semantics.kind, "mcp_prompt");
  assert.equal(definitions[2]?.semantics.kind, "mcp_resource");
  assert.equal(
    definitions[0]?.sourceRef.kind === "mcp_tool"
      ? definitions[0].sourceRef.serverInstallId
      : null,
    "mcp_install_1",
  );
  assert.equal(definitions[0]?.metadata?.mcpClientPath, "apps/backend/src/modules/mcp/langchain-client.ts");
  assert.equal(definitions[0]?.metadata?.mcpStatus, "active");
  assert.equal(definitions[0]?.metadata?.risk, "high");
});

test("workspace MCP provider uses marketplace identifier for projected tool names", () => {
  const install = createWorkspaceMcpInstall({
    id: "install_123",
    workspaceId: "workspace_1",
    source: "marketplace",
    marketIdentifier: "github_marketplace",
    transport: "streamable_http",
    endpointUrl: "https://mcp.example.com/mcp",
    manifest: createWorkspaceMcpManifestSnapshot({
      serverInstallId: "install_123",
      discoveredAt: "2026-01-01T00:00:00.000Z",
      schemaHash: "manifest_hash",
      tools: [
        {
          id: "tool_1",
          serverInstallId: "install_123",
          serverToolName: "create_issue",
          normalizedToolName: "github_create_issue",
          title: "Create issue",
          description: "Create an issue",
          inputSchema: { type: "object" },
          outputSchema: null,
          risk: "low",
          enabled: true,
          schemaHash: "tool_hash",
        },
      ],
      prompts: [],
      resources: [],
    }),
  });

  const definition = createWorkspaceMcpInvocationProvider({ installs: [install] }).list()[0];

  assert.equal(
    definition?.semantics.kind === "fixed_tool_choice"
      ? definition.semantics.toolName
      : null,
    "mcp__github_marketplace__github_create_issue",
  );
  assert.equal(definition?.metadata?.serverKey, "github_marketplace");
});

test("workspace MCP provider contains no built-in external capabilities", () => {
  const provider = createWorkspaceMcpInvocationProvider({ installs: [] });
  assert.deepEqual(provider.list(), []);
});
