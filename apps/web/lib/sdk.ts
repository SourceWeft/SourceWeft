import {
  BillingClient,
  ConnectorsClient,
  ContentClient,
  HttpClient,
  JobsClient,
  LlmObservabilityClient,
  WorkspaceClient,
} from "@sourceweft/sdk";
import { apiBaseUrl } from "./api-base-url";

export { apiBaseUrl };

const httpClient = new HttpClient({
  baseUrl: apiBaseUrl,
  credentials: "include",
});

export const jobsClient = new JobsClient(httpClient);
export const billingClient = new BillingClient(httpClient);
export const connectorsClient = new ConnectorsClient(httpClient);
export const contentClient = new ContentClient(httpClient);
export const workspaceClient = new WorkspaceClient(httpClient);
export const llmObservabilityClient = new LlmObservabilityClient(httpClient);
