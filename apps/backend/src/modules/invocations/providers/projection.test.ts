import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";
import { createSelectableInvocationRegistry } from "../registry";
import { createCapabilityToolInvocationProvider } from "./capability-tools";
import { capabilityCommand } from "./capability-tool-fixtures";
import { createSkillCommandInvocationProvider } from "./skills";
import { createWorkspaceMcpInvocationProvider } from "./workspace-mcp";
import { createWorkspaceMcpManifestSnapshot, createWorkspaceMcpInstall } from "../mcp-install";

test("obsolete builtin tool compatibility provider is deleted", async () => {
  await assert.rejects(
    readFile(
      join(
        process.cwd(),
        "src/modules/invocations/providers/builtin-tools.ts",
      ),
      "utf8",
    ),
  );
});

test("legacy builtin_tool selectable ids are documented as removed", async () => {
  const repositoryRoot = join(process.cwd(), "../..");
  const capabilityBindingDoc = await readFile(
    join(repositoryRoot, "docs/architecture/capability-binding.md"),
    "utf8",
  );

  assert.match(
    capabilityBindingDoc,
    /Legacy `builtin_tool\.\*` selectable IDs and `legacyIds` aliases were removed/u,
  );
});

test("legacy builtin_tool selectable ids do not resolve", () => {
  const registry = createSelectableInvocationRegistry({
    providers: [
      createCapabilityToolInvocationProvider({
        commands: [
          capabilityCommand({
            action: { kind: "tool", targetId: "generate_image" },
            capabilityId: "sourceweft/generate-image",
            contributionId: "generate_image",
            id: "cap:sourceweft/generate-image:generate_image",
            title: "Generate Image",
          }),
        ],
      }),
    ],
  });

  assert.equal(registry.resolve("cap:sourceweft/generate-image:generate_image")?.id, "cap:sourceweft/generate-image:generate_image");
  assert.equal(registry.resolve("builtin_tool.generate_image"), null);
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
