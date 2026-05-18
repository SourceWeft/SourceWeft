import { billingService } from "../billing";
import { ConnectorActionRunner } from "./action-runner";
import { ConnectorOAuthService } from "./oauth-service";
import { registerBuiltinConnectorAdapters } from "./register-builtin-adapters";
import { ConnectorService } from "./service";
import { ConnectorSyncOrchestrator } from "./sync-orchestrator";
import { ConnectorWebhookService } from "./webhook-service";

export { ConnectorActionRunner } from "./action-runner";
export { ConnectorError, isConnectorError } from "./errors";
export { ConnectorOAuthService } from "./oauth-service";
export { ConnectorRegistry, connectorRegistry } from "./registry";
export { ConnectorService } from "./service";
export { ConnectorSyncOrchestrator } from "./sync-orchestrator";
export { ConnectorWebhookService } from "./webhook-service";
export type {
  ConnectorAdapter,
  ConnectorActionResult,
  ConnectorDiscoverInput,
  ConnectorExtractedContent,
  ConnectorExtractInput,
  ConnectorItem,
  ConnectorManifest,
  OAuthCodeExchangeInput,
  OAuthRefreshInput,
  OAuthTokenSet,
} from "./types";

registerBuiltinConnectorAdapters();

export const connectorService = new ConnectorService();
export const connectorOAuthService = new ConnectorOAuthService();
export const connectorSyncOrchestrator = new ConnectorSyncOrchestrator(
  billingService,
);
export const connectorActionRunner = new ConnectorActionRunner();
export const connectorWebhookService = new ConnectorWebhookService();
