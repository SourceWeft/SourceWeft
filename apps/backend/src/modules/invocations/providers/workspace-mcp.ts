import type { SelectableInvocationDefinitionWithAlias, SelectableInvocationProvider } from "../registry";
import type { WorkspaceMcpInstall } from "../mcp-install";

const MCP_CLIENT_PATH = "apps/backend/src/modules/mcp/langchain-client.ts";

function resolveInstallStatus(install: WorkspaceMcpInstall) {
  if (!install.enabled || install.status === "disabled") {
    return "disabled" as const;
  }
  if (
    install.credentialStatus === "required" ||
    install.credentialStatus === "invalid" ||
    install.status === "needs_auth"
  ) {
    return "needs_auth" as const;
  }
  if (!install.endpointUrl || install.status === "unreachable") {
    return "unreachable" as const;
  }
  return "active" as const;
}

function unavailableReason(status: ReturnType<typeof resolveInstallStatus>) {
  switch (status) {
    case "disabled":
      return "MCP install is disabled";
    case "needs_auth":
      return "MCP install requires authentication";
    case "unreachable":
      return "MCP install is unreachable";
    case "active":
      return undefined;
  }
}

export function createWorkspaceMcpInvocationProvider(input: {
  installs: WorkspaceMcpInstall[];
}): SelectableInvocationProvider {
  return {
    id: "workspace_mcp",
    list() {
      return input.installs.flatMap((install) => {
        const status = resolveInstallStatus(install);
        const serverKey = install.marketIdentifier ?? install.id;
        const manifest = install.manifest;
        const tools = manifest.tools.map(
          (tool): SelectableInvocationDefinitionWithAlias => ({
            id: `mcp_tool.${install.id}.${tool.normalizedToolName}`,
            label: tool.title ?? tool.serverToolName,
            description: tool.description ?? undefined,
            enabled: status === "active" && tool.enabled,
            sourceRef: {
              kind: "mcp_tool",
              serverInstallId: install.id,
              serverToolName: tool.serverToolName,
              normalizedToolName: tool.normalizedToolName,
              toolId: tool.id,
            },
            semantics: {
              kind: "fixed_tool_choice",
              target: "mcp_tool",
              toolName: `mcp__${serverKey}__${tool.normalizedToolName}`,
            },
            unavailableReason: tool.enabled
              ? unavailableReason(status)
              : "MCP tool is disabled",
            metadata: {
              mcpClientPath: MCP_CLIENT_PATH,
              mcpStatus: status,
              manifestFresh: Boolean(manifest.schemaHash),
              schemaMatches: Boolean(tool.schemaHash),
              serverKey,
              manifestSchemaHash: manifest.schemaHash,
              capabilitySchemaHash: tool.schemaHash,
              risk: tool.risk,
            },
          }),
        );
        const prompts = manifest.prompts.map(
          (prompt): SelectableInvocationDefinitionWithAlias => ({
            id: `mcp_prompt.${install.id}.${prompt.name}`,
            label: prompt.title ?? prompt.name,
            description: prompt.description ?? undefined,
            enabled: status === "active" && prompt.enabled,
            sourceRef: {
              kind: "mcp_prompt",
              serverInstallId: install.id,
              promptName: prompt.name,
            },
            semantics: { kind: "mcp_prompt", promptName: prompt.name },
            unavailableReason: prompt.enabled
              ? unavailableReason(status)
              : "MCP prompt is disabled",
            metadata: {
              mcpStatus: status,
              manifestFresh: Boolean(manifest.schemaHash),
              schemaMatches: Boolean(prompt.schemaHash),
              manifestSchemaHash: manifest.schemaHash,
              capabilitySchemaHash: prompt.schemaHash,
            },
          }),
        );
        const resources = manifest.resources.map(
          (resource): SelectableInvocationDefinitionWithAlias => ({
            id: `mcp_resource.${install.id}.${resource.id}`,
            label: resource.title ?? resource.uri,
            description: resource.description ?? undefined,
            enabled: status === "active" && resource.enabled,
            sourceRef: {
              kind: "mcp_resource",
              serverInstallId: install.id,
              uri: resource.uri,
            },
            semantics: { kind: "mcp_resource", uri: resource.uri },
            unavailableReason: resource.enabled
              ? unavailableReason(status)
              : "MCP resource is disabled",
            metadata: {
              mcpStatus: status,
              manifestFresh: Boolean(manifest.schemaHash),
              schemaMatches: Boolean(resource.schemaHash),
              manifestSchemaHash: manifest.schemaHash,
              capabilitySchemaHash: resource.schemaHash,
              mimeType: resource.mimeType,
            },
          }),
        );
        return [...tools, ...prompts, ...resources];
      });
    },
  };
}
