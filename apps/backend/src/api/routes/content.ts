import { Hono } from "hono";
import { registerByokRoutes } from "./content/byok";
import { registerWorkspaceLlmObservabilityRoutes } from "./llm-observability";
import { registerModelGatewayRoutes } from "./content/model-gateway";
import { registerSourceRoutes } from "./content/sources";
import { registerSkillRoutes } from "./content/skills";
import { registerThreadRoutes } from "./content/threads";
import { registerWorkingFileRoutes } from "./content/working-files";

export function registerContentRoutes(app: Hono) {
  const workspaceRoutes = new Hono();

  registerSourceRoutes(workspaceRoutes);
  registerSkillRoutes(workspaceRoutes);
  registerThreadRoutes(workspaceRoutes);
  registerWorkingFileRoutes(workspaceRoutes);
  registerByokRoutes(workspaceRoutes);
  registerModelGatewayRoutes(workspaceRoutes);
  registerWorkspaceLlmObservabilityRoutes(workspaceRoutes);

  app.route("/v1/workspaces/:workspaceId", workspaceRoutes);
}
