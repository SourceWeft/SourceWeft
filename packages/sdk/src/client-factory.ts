import { DeploymentClient } from "./deployment-client";
import { BillingClient } from "./billing-client";
import { ConnectorsClient } from "./connectors-client";
import { ContentClient } from "./content-client";
import { DashboardClient } from "./dashboard-client";
import { HttpClient } from "./http-client";
import { JobsClient } from "./jobs-client";
import { LlmObservabilityClient } from "./llm-observability-client";
import { UserSettingsClient } from "./user-settings-client";
import { WorkspaceClient } from "./workspace-client";

export type SourceweftClient = {
  readonly http: HttpClient;
  readonly billing: BillingClient;
  readonly deployment: DeploymentClient;
  readonly connectors: ConnectorsClient;
  readonly content: ContentClient;
  readonly dashboard: DashboardClient;
  readonly jobs: JobsClient;
  readonly llmObservability: LlmObservabilityClient;
  readonly userSettings: UserSettingsClient;
  readonly workspace: WorkspaceClient;
};

/**
 * Create a pre-configured SourceWeft API client.
 *
 * Desktop and Mobile apps call this with the backend base URL so all
 * clients share a single HttpClient instance.
 *
 * @example
 *   const client = createSourceweftClient("http://localhost:3001");
 *   await client.jobs.poll(...);
 */
export function createSourceweftClient(baseUrl: string): SourceweftClient {
  const http = new HttpClient({ baseUrl });

  return {
    http,
    billing: new BillingClient(http),
    deployment: new DeploymentClient(http),
    connectors: new ConnectorsClient(http),
    content: new ContentClient(http),
    dashboard: new DashboardClient(http),
    jobs: new JobsClient(http),
    llmObservability: new LlmObservabilityClient(http),
    userSettings: new UserSettingsClient(http),
    workspace: new WorkspaceClient(http),
  };
}
