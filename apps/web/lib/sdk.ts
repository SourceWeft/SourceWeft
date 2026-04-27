import {
  BillingClient,
  ContentClient,
  HttpClient,
  JobsClient,
  WorkspaceClient,
} from "@sourceweft/sdk";

const apiBaseUrl =
  process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:3001";

export { apiBaseUrl };

const httpClient = new HttpClient({
  baseUrl: apiBaseUrl,
  credentials: "include",
});

export const jobsClient = new JobsClient(httpClient);
export const billingClient = new BillingClient(httpClient);
export const contentClient = new ContentClient(httpClient);
export const workspaceClient = new WorkspaceClient(httpClient);
