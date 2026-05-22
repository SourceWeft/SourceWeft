import { z } from "zod";
import {
  mcpAuthTypeSchema,
  mcpRiskLevelSchema,
  mcpTransportSchema,
  marketMcpManifestSchema,
  marketMcpToolManifestSchema,
} from "@sourceweft/market-contracts";

export const workspaceMcpInstallStatusSchema = z.enum([
  "active",
  "disabled",
  "error",
]);

export const workspaceMcpCredentialStatusSchema = z.enum([
  "not_required",
  "required",
  "configured",
  "invalid",
]);

export const mcpInstallSourceSchema = z.enum([
  "market",
  "custom",
  "local_import",
]);

export const installMarketMcpRequestSchema = z.object({
  version: z.string().optional(),
  endpointUrlOverride: z.string().url().optional(),
});

export const updateWorkspaceMcpInstallRequestSchema = z.object({
  enabled: z.boolean().optional(),
  toolIds: z.array(z.string()).optional(),
});

export const upsertWorkspaceMcpCredentialsRequestSchema = z.object({
  authType: mcpAuthTypeSchema,
  bearerToken: z.string().optional(),
  apiKeyHeaderName: z.string().optional(),
  apiKey: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

export const mcpToolSelectionSchema = z.object({
  enabled: z.boolean().optional(),
  installId: z.string().optional(),
  installIds: z.array(z.string()).optional(),
  toolIds: z.array(z.string()).optional(),
});

export const workspaceMcpToolSchema = z.object({
  id: z.string(),
  installId: z.string(),
  serverToolName: z.string(),
  normalizedToolName: z.string(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()).nullable(),
  annotations: z.record(z.string(), z.unknown()),
  risk: mcpRiskLevelSchema,
  enabled: z.boolean(),
  lastDiscoveredHash: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const workspaceMcpInstallSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  workspaceId: z.string(),
  source: mcpInstallSourceSchema,
  marketIdentifier: z.string().nullable(),
  marketVersion: z.string().nullable(),
  name: z.string(),
  summary: z.string(),
  transport: mcpTransportSchema,
  endpointUrl: z.string().nullable(),
  status: workspaceMcpInstallStatusSchema,
  official: z.boolean(),
  verified: z.boolean(),
  desktopOnly: z.boolean(),
  webExecutable: z.boolean(),
  authType: mcpAuthTypeSchema,
  credentialStatus: workspaceMcpCredentialStatusSchema,
  enabled: z.boolean(),
  manifestJson: marketMcpManifestSchema,
  signature: z.string().nullable(),
  signingKeyId: z.string().nullable(),
  lastTestedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  tools: z.array(workspaceMcpToolSchema).default([]),
});

export const listWorkspaceMarketMcpResponseSchema = z.object({
  items: z.array(
    z.object({
      market: z.record(z.string(), z.unknown()),
      install: workspaceMcpInstallSchema.nullable(),
    }),
  ),
});

export const getWorkspaceMarketMcpResponseSchema = z.object({
  market: z.record(z.string(), z.unknown()),
  install: workspaceMcpInstallSchema.nullable(),
});

export const installMarketMcpResponseSchema = z.object({
  install: workspaceMcpInstallSchema,
});

export const listWorkspaceMcpInstallsResponseSchema = z.object({
  items: z.array(workspaceMcpInstallSchema),
});

export const updateWorkspaceMcpInstallResponseSchema = z.object({
  install: workspaceMcpInstallSchema,
});

export const upsertWorkspaceMcpCredentialsResponseSchema = z.object({
  install: workspaceMcpInstallSchema,
});

export const testWorkspaceMcpInstallResponseSchema = z.object({
  install: workspaceMcpInstallSchema,
  toolCount: z.number(),
});

export type WorkspaceMcpInstallStatus = z.infer<
  typeof workspaceMcpInstallStatusSchema
>;
export type WorkspaceMcpCredentialStatus = z.infer<
  typeof workspaceMcpCredentialStatusSchema
>;
export type McpInstallSource = z.infer<typeof mcpInstallSourceSchema>;
export type InstallMarketMcpRequest = z.infer<
  typeof installMarketMcpRequestSchema
>;
export type UpdateWorkspaceMcpInstallRequest = z.infer<
  typeof updateWorkspaceMcpInstallRequestSchema
>;
export type UpsertWorkspaceMcpCredentialsRequest = z.infer<
  typeof upsertWorkspaceMcpCredentialsRequestSchema
>;
export type McpToolSelection = z.infer<typeof mcpToolSelectionSchema>;
export type WorkspaceMcpTool = z.infer<typeof workspaceMcpToolSchema>;
export type WorkspaceMcpInstall = z.infer<typeof workspaceMcpInstallSchema>;
export type ListWorkspaceMarketMcpResponse = z.infer<
  typeof listWorkspaceMarketMcpResponseSchema
>;
export type GetWorkspaceMarketMcpResponse = z.infer<
  typeof getWorkspaceMarketMcpResponseSchema
>;
export type InstallMarketMcpResponse = z.infer<
  typeof installMarketMcpResponseSchema
>;
export type ListWorkspaceMcpInstallsResponse = z.infer<
  typeof listWorkspaceMcpInstallsResponseSchema
>;
export type UpdateWorkspaceMcpInstallResponse = z.infer<
  typeof updateWorkspaceMcpInstallResponseSchema
>;
export type UpsertWorkspaceMcpCredentialsResponse = z.infer<
  typeof upsertWorkspaceMcpCredentialsResponseSchema
>;
export type TestWorkspaceMcpInstallResponse = z.infer<
  typeof testWorkspaceMcpInstallResponseSchema
>;
export type MarketMcpToolManifest = z.infer<
  typeof marketMcpToolManifestSchema
>;
