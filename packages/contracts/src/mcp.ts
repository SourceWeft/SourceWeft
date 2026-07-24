import { z } from "zod";
import {
  mcpAuthTypeSchema,
  mcpRiskLevelSchema,
  mcpTransportSchema,
  getMarketMcpResponseSchema,
  listMarketCategoriesResponseSchema,
  marketItemSummarySchema,
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

export const upsertWorkspaceMcpCredentialsRequestSchema = z
  .object({
    authType: mcpAuthTypeSchema,
    bearerToken: z.string().optional(),
    apiKeyHeaderName: z.string().optional(),
    apiKey: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
  })
  // Reject empty submissions per auth type so a blank Save can't overwrite (and
  // wipe) a previously configured credential.
  .superRefine((value, ctx) => {
    if (value.authType === "bearer" && !value.bearerToken?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["bearerToken"],
        message: "Bearer token is required",
      });
    }
    if (value.authType === "api_key_header") {
      if (!value.apiKeyHeaderName?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["apiKeyHeaderName"],
          message: "API key header name is required",
        });
      }
      if (!value.apiKey?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["apiKey"],
          message: "API key value is required",
        });
      }
    }
    if (value.authType === "custom_headers") {
      const nonEmpty = Object.entries(value.headers ?? {}).filter(
        ([key, headerValue]) => key.trim() && headerValue.trim(),
      );
      if (nonEmpty.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["headers"],
          message: "At least one non-empty header is required",
        });
      }
    }
  });

export const mcpToolSelectionSchema = z.object({
  enabled: z.boolean().optional(),
  installId: z.string().optional(),
  installIds: z.array(z.string()).optional(),
  toolIds: z.array(z.string()).optional(),
});

export const mcpToolRunStatusSchema = z.enum([
  "running",
  "succeeded",
  "failed",
  "proposed",
  "rejected",
  "canceled",
]);

export const mcpActionRunStatusSchema = z.enum([
  "proposed",
  "approved",
  "rejected",
  "running",
  "succeeded",
  "failed",
  "canceled",
]);

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
      market: marketItemSummarySchema,
      install: workspaceMcpInstallSchema.nullable(),
    }),
  ),
  // Keyset cursor for the next catalog page; null when this page is the last.
  nextCursor: z.string().nullable().optional(),
});

export const listWorkspaceMarketMcpCategoriesResponseSchema =
  listMarketCategoriesResponseSchema;

export const getWorkspaceMarketMcpResponseSchema = z.object({
  market: getMarketMcpResponseSchema,
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

export const deleteWorkspaceMcpInstallResponseSchema = z.object({
  deleted: z.literal(true),
  installId: z.string(),
});

export const upsertWorkspaceMcpCredentialsResponseSchema = z.object({
  install: workspaceMcpInstallSchema,
});

export const testWorkspaceMcpInstallResponseSchema = z.object({
  install: workspaceMcpInstallSchema,
  toolCount: z.number(),
});

export const workspaceMcpToolRunSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  workspaceId: z.string(),
  threadId: z.string().nullable(),
  runId: z.string().nullable(),
  toolCallId: z.string().nullable(),
  installId: z.string().nullable(),
  toolId: z.string().nullable(),
  actionRunId: z.string().nullable(),
  serverToolName: z.string(),
  normalizedToolName: z.string(),
  risk: mcpRiskLevelSchema,
  status: mcpToolRunStatusSchema,
  redactedInput: z.record(z.string(), z.unknown()),
  redactedOutput: z.record(z.string(), z.unknown()),
  latencyMs: z.number().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  install: z
    .object({
      id: z.string(),
      name: z.string(),
      marketIdentifier: z.string().nullable(),
      official: z.boolean(),
      verified: z.boolean(),
    })
    .nullable(),
});

export const workspaceMcpActionRunSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  workspaceId: z.string(),
  installId: z.string(),
  toolId: z.string().nullable(),
  serverToolName: z.string(),
  normalizedToolName: z.string(),
  risk: mcpRiskLevelSchema,
  status: mcpActionRunStatusSchema,
  requestJson: z.record(z.string(), z.unknown()),
  requestPreview: z.string(),
  resultJson: z.record(z.string(), z.unknown()),
  approvedBy: z.string().nullable(),
  executedBy: z.string().nullable(),
  idempotencyKey: z.string(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  install: z
    .object({
      id: z.string(),
      name: z.string(),
      marketIdentifier: z.string().nullable(),
      official: z.boolean(),
      verified: z.boolean(),
    })
    .nullable(),
});

export const listWorkspaceMcpRunsResponseSchema = z.object({
  items: z.array(workspaceMcpToolRunSchema),
  nextCursor: z.string().nullable(),
});

export const listWorkspaceMcpActionRunsResponseSchema = z.object({
  items: z.array(workspaceMcpActionRunSchema),
  nextCursor: z.string().nullable(),
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
export type McpToolRunStatus = z.infer<typeof mcpToolRunStatusSchema>;
export type McpActionRunStatus = z.infer<typeof mcpActionRunStatusSchema>;
export type WorkspaceMcpTool = z.infer<typeof workspaceMcpToolSchema>;
export type WorkspaceMcpInstall = z.infer<typeof workspaceMcpInstallSchema>;
export type ListWorkspaceMarketMcpResponse = z.infer<
  typeof listWorkspaceMarketMcpResponseSchema
>;
export type ListWorkspaceMarketMcpCategoriesResponse = z.infer<
  typeof listWorkspaceMarketMcpCategoriesResponseSchema
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
export type DeleteWorkspaceMcpInstallResponse = z.infer<
  typeof deleteWorkspaceMcpInstallResponseSchema
>;
export type UpsertWorkspaceMcpCredentialsResponse = z.infer<
  typeof upsertWorkspaceMcpCredentialsResponseSchema
>;
export type TestWorkspaceMcpInstallResponse = z.infer<
  typeof testWorkspaceMcpInstallResponseSchema
>;
export type WorkspaceMcpToolRun = z.infer<typeof workspaceMcpToolRunSchema>;
export type WorkspaceMcpActionRun = z.infer<
  typeof workspaceMcpActionRunSchema
>;
export type ListWorkspaceMcpRunsResponse = z.infer<
  typeof listWorkspaceMcpRunsResponseSchema
>;
export type ListWorkspaceMcpActionRunsResponse = z.infer<
  typeof listWorkspaceMcpActionRunsResponseSchema
>;
export type MarketMcpToolManifest = z.infer<
  typeof marketMcpToolManifestSchema
>;
export type {
  McpAuthType,
  McpRiskLevel,
  McpTransport,
} from "@sourceweft/market-contracts";
