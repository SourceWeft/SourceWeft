import { Hono } from "hono";
import { registerArtifactRoutes } from "./content/artifacts";
import { registerArtifactRecordRoutes } from "./content/artifact-records";
import { registerArtifactNavigationRoutes } from "./content/artifact-navigation";
import { registerArtifactRecordExportRoutes } from "./content/artifact-records-export";
import { registerArtifactSharedCollectionRoutes } from "./content/artifact-shared-collections";
import { registerAgentConfirmationRoutes } from "./content/agent-confirmations";
import { registerAgentTaskRoutes } from "./content/agent-tasks";
import { registerByokRoutes } from "./content/byok";
import { registerCapabilityRoutes } from "./content/capabilities";
import { registerConnectorRoutes } from "./content/connectors";
import { registerDictationRoutes } from "./content/dictation";
import { registerWorkspaceLlmObservabilityRoutes } from "./llm-observability";
import { registerModelGatewayRoutes } from "./content/model-gateway";
import {
  registerMcpOAuthCallbackRoutes,
  registerMcpRoutes,
} from "./content/mcp";
import { registerNotificationRoutes } from "./content/notifications";
import { registerSourceRoutes } from "./content/sources";
import { registerSkillRoutes } from "./content/skills";
import { registerSkillSubmissionRoutes } from "./content/skill-submissions";
import { registerSkillClaimRoutes } from "./content/skill-claims";
import { registerStudyStateRoutes } from "./content/study-state";
import { registerThreadRoutes } from "./content/threads";
import { registerWorkingFileRoutes } from "./content/working-files";
import { registerSourceSelectionRoutes } from "./content/source-selection";
import { registerStudyRoutes } from "./content/study";
import { registerTableRoutes } from "./content/tables";

export function registerContentRoutes(app: Hono) {
  const workspaceRoutes = new Hono();

  registerAgentConfirmationRoutes(workspaceRoutes);
  registerAgentTaskRoutes(workspaceRoutes);
  registerNotificationRoutes(workspaceRoutes);
  registerArtifactRoutes(workspaceRoutes);
  registerArtifactRecordRoutes(workspaceRoutes);
  registerArtifactNavigationRoutes(workspaceRoutes);
  registerArtifactRecordExportRoutes(workspaceRoutes);
  registerArtifactSharedCollectionRoutes(workspaceRoutes);
  registerCapabilityRoutes(workspaceRoutes);
  registerSourceRoutes(workspaceRoutes);
  registerDictationRoutes(workspaceRoutes);
  registerStudyRoutes(workspaceRoutes);
  registerTableRoutes(workspaceRoutes);
  registerConnectorRoutes(workspaceRoutes);
  registerSkillRoutes(workspaceRoutes);
  registerSkillSubmissionRoutes(workspaceRoutes);
  registerSkillClaimRoutes(workspaceRoutes);
  registerThreadRoutes(workspaceRoutes);
  registerWorkingFileRoutes(workspaceRoutes);
  registerSourceSelectionRoutes(workspaceRoutes);
  registerStudyStateRoutes(workspaceRoutes);
  registerByokRoutes(workspaceRoutes);
  registerMcpRoutes(workspaceRoutes);
  registerModelGatewayRoutes(workspaceRoutes);
  registerWorkspaceLlmObservabilityRoutes(workspaceRoutes);

  app.route("/v1/workspaces/:workspaceId", workspaceRoutes);

  // Non-workspace-scoped: the OAuth provider redirects here after consent.
  registerMcpOAuthCallbackRoutes(app);
}
