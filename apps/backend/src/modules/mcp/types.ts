import type { McpAuthType, McpRiskLevel, McpTransport } from "@sourceweft/market-sdk";

export type WorkspaceMcpInstallStatus = "active" | "disabled" | "error";
export type WorkspaceMcpCredentialStatus =
  | "not_required"
  | "required"
  | "configured"
  | "invalid";
export type McpInstallSource = "market" | "custom" | "local_import";

export type WorkspaceMcpToolRecord = {
  id: string;
  teamId: string;
  workspaceId: string;
  installId: string;
  serverToolName: string;
  normalizedToolName: string;
  title: string | null;
  description: string | null;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown> | null;
  annotations: Record<string, unknown>;
  risk: McpRiskLevel;
  enabled: boolean;
  lastDiscoveredHash: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceMcpInstallRecord = {
  id: string;
  teamId: string;
  workspaceId: string;
  source: McpInstallSource;
  marketIdentifier: string | null;
  marketVersion: string | null;
  name: string;
  summary: string;
  transport: McpTransport;
  endpointUrl: string | null;
  status: WorkspaceMcpInstallStatus;
  official: boolean;
  verified: boolean;
  desktopOnly: boolean;
  webExecutable: boolean;
  authType: McpAuthType;
  credentialStatus: WorkspaceMcpCredentialStatus;
  enabled: boolean;
  manifestJson: Record<string, unknown>;
  signature: string | null;
  signingKeyId: string | null;
  lastTestedAt: string | null;
  lastError: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  tools: WorkspaceMcpToolRecord[];
};

export type WorkspaceMcpCredentialRecord = {
  id: string;
  teamId: string;
  workspaceId: string;
  installId: string;
  userId: string;
  authType: McpAuthType;
  encryptedSecret: string | null;
  encryptedHeaders: string | null;
  headerName: string | null;
  status: WorkspaceMcpCredentialStatus;
  configuredBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type McpActionRunStatus =
  | "proposed"
  | "approved"
  | "rejected"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled";

export type McpActionRunRecord = {
  id: string;
  teamId: string;
  workspaceId: string;
  installId: string;
  toolId: string | null;
  serverToolName: string;
  normalizedToolName: string;
  risk: McpRiskLevel;
  status: McpActionRunStatus;
  requestJson: Record<string, unknown>;
  requestPreview: string;
  resultJson: Record<string, unknown>;
  approvedBy: string | null;
  executedBy: string | null;
  idempotencyKey: string;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

export type McpToolRunStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "proposed"
  | "rejected"
  | "canceled";

export type McpToolRunRecord = {
  id: string;
  teamId: string;
  workspaceId: string;
  threadId: string | null;
  runId: string | null;
  toolCallId: string | null;
  installId: string | null;
  toolId: string | null;
  actionRunId: string | null;
  serverToolName: string;
  normalizedToolName: string;
  risk: McpRiskLevel;
  status: McpToolRunStatus;
  redactedInput: Record<string, unknown>;
  redactedOutput: Record<string, unknown>;
  latencyMs: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type McpRunInstallSummary = {
  id: string;
  name: string;
  marketIdentifier: string | null;
  official: boolean;
  verified: boolean;
};

export type McpToolRunWithInstallRecord = McpToolRunRecord & {
  install: McpRunInstallSummary | null;
};

export type McpActionRunWithInstallRecord = McpActionRunRecord & {
  install: McpRunInstallSummary | null;
};
