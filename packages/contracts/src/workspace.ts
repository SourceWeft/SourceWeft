import { z } from "zod";

export const workspaceSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  slug: z.string(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
});

export const createWorkspaceRequestSchema = z.object({
  name: z.string().min(1),
});

export const updateWorkspaceRequestSchema = z.object({
  name: z.string().min(1),
});

export const listWorkspacesResponseSchema = z.object({
  items: z.array(workspaceSchema),
});

export const setWorkspaceContextRequestSchema = z.object({
  workspaceId: z.string().min(1),
});

export const setWorkspaceContextResponseSchema = z.object({
  workspace: workspaceSchema,
});

export const currentContextResponseSchema = z.object({
  authenticated: z.boolean(),
  user: z.unknown().optional(),
  activeOrganizationId: z.string().nullable().optional(),
  activeWorkspace: workspaceSchema.nullable().optional(),
});

export type Workspace = z.infer<typeof workspaceSchema>;
export type CreateWorkspaceRequest = z.infer<
  typeof createWorkspaceRequestSchema
>;
export type UpdateWorkspaceRequest = z.infer<
  typeof updateWorkspaceRequestSchema
>;
export type ListWorkspacesResponse = z.infer<
  typeof listWorkspacesResponseSchema
>;
export type SetWorkspaceContextRequest = z.infer<
  typeof setWorkspaceContextRequestSchema
>;
export type SetWorkspaceContextResponse = z.infer<
  typeof setWorkspaceContextResponseSchema
>;
export type CurrentContextResponse = z.infer<
  typeof currentContextResponseSchema
>;
