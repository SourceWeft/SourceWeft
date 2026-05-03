import { Hono } from "hono";
import { registerByokRoutes } from "./content/byok";
import { registerWorkspaceLlmObservabilityRoutes } from "./llm-observability";
import { registerModelGatewayRoutes } from "./content/model-gateway";
import { registerSourceRoutes } from "./content/sources";
import { registerThreadRoutes } from "./content/threads";

export function registerContentRoutes(app: Hono) {
  const workspaceRoutes = new Hono();

  registerSourceRoutes(workspaceRoutes);
  registerThreadRoutes(workspaceRoutes);
  registerByokRoutes(workspaceRoutes);
  registerModelGatewayRoutes(workspaceRoutes);
  registerWorkspaceLlmObservabilityRoutes(workspaceRoutes);

  app.route("/v1/workspaces/:workspaceId", workspaceRoutes);
}
