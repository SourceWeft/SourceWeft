import { Hono } from "hono";
import { registerArtifactRoutes } from "./content/artifacts";
import { registerAgentConfirmationRoutes } from "./content/agent-confirmations";
import { registerByokRoutes } from "./content/byok";
import { registerConnectorRoutes } from "./content/connectors";
import { registerWorkspaceLlmObservabilityRoutes } from "./llm-observability";
import { registerModelGatewayRoutes } from "./content/model-gateway";
import { registerMcpRoutes } from "./content/mcp";
import { registerSourceRoutes } from "./content/sources";
import { registerSkillRoutes } from "./content/skills";
import { registerThreadRoutes } from "./content/threads";
import { registerWorkingFileRoutes } from "./content/working-files";

export function registerContentRoutes(app: Hono) {
  const workspaceRoutes = new Hono();

  registerAgentConfirmationRoutes(workspaceRoutes);
  registerArtifactRoutes(workspaceRoutes);
  registerSourceRoutes(workspaceRoutes);
  registerConnectorRoutes(workspaceRoutes);
  registerSkillRoutes(workspaceRoutes);
  registerThreadRoutes(workspaceRoutes);
  registerWorkingFileRoutes(workspaceRoutes);
  registerByokRoutes(workspaceRoutes);
  registerMcpRoutes(workspaceRoutes);
  registerModelGatewayRoutes(workspaceRoutes);
  registerWorkspaceLlmObservabilityRoutes(workspaceRoutes);

  app.route("/v1/workspaces/:workspaceId", workspaceRoutes);
}
