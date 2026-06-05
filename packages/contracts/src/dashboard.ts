import { z } from "zod";
import { listThreadModelCatalogResponseSchema, listThreadsResponseSchema } from "./content";
import { workspaceSchema } from "./workspace";

export const dashboardChatBootstrapWarningSchema = z.object({
  field: z.string(),
  code: z.string(),
  message: z.string(),
});

export const dashboardChatBootstrapCacheHintsSchema = z.object({
  workspaceSources: z.object({
    version: z.string(),
    ttlMs: z.number().int().nonnegative(),
  }),
  workspaceHub: z.object({
    version: z.string(),
    ttlMs: z.number().int().nonnegative(),
    buckets: z.array(z.enum(["artifacts", "connectors", "mcp"])),
  }),
});

export const dashboardChatBootstrapResponseSchema = z.object({
  authenticated: z.literal(true),
  user: z.unknown(),
  activeOrganizationId: z.string(),
  activeOrganizationName: z.string(),
  activeWorkspace: workspaceSchema,
  workspaces: z.array(workspaceSchema),
  privateChats: listThreadsResponseSchema,
  modelCatalog: listThreadModelCatalogResponseSchema.nullable(),
  modelCatalogDeferred: z.boolean().optional(),
  cacheHints: dashboardChatBootstrapCacheHintsSchema,
  warnings: z.array(dashboardChatBootstrapWarningSchema),
});

export type DashboardChatBootstrapWarning = z.infer<
  typeof dashboardChatBootstrapWarningSchema
>;
export type DashboardChatBootstrapCacheHints = z.infer<
  typeof dashboardChatBootstrapCacheHintsSchema
>;
export type DashboardChatBootstrapResponse = z.infer<
  typeof dashboardChatBootstrapResponseSchema
>;
