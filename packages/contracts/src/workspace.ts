import { z } from "zod";

export const workspaceSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  slug: z.string(),
  isDefault: z.boolean().optional(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
});

export const workspaceRoleSchema = z.enum([
  "workspace_admin",
  "editor",
  "viewer",
]);

/**
 * A member's standing in a workspace, as returned by the members endpoint.
 * `source` distinguishes a role that follows from organization membership
 * (`derived`) from one written explicitly for this workspace (`explicit`);
 * `organizationRole` is the raw better-auth role, so the UI can tell that a
 * member also administers the container.
 */
export const workspaceMemberSchema = z.object({
  workspaceId: z.string(),
  userId: z.string(),
  role: workspaceRoleSchema,
  source: z.enum(["derived", "explicit"]),
  organizationRole: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  image: z.string().nullable(),
});

export const listWorkspaceMembersResponseSchema = z.object({
  items: z.array(workspaceMemberSchema),
});

export const addWorkspaceMemberRequestSchema = z.object({
  userId: z.string().min(1),
  role: workspaceRoleSchema,
});

export const updateWorkspaceMemberRoleRequestSchema = z.object({
  role: workspaceRoleSchema,
});

export const workspaceMemberMutationResponseSchema = z.object({
  ok: z.literal(true),
});

export const teamAuditLogSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  actorUserId: z.string().nullable(),
  action: z.string(),
  targetType: z.string(),
  targetId: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});

export const listTeamAuditLogsResponseSchema = z.object({
  items: z.array(teamAuditLogSchema),
});

/**
 * Guest collaboration: a guest is invited to one workspace by email, with a
 * viewer/editor role, and is not an organization member (no seat).
 */
export const guestRoleSchema = z.enum(["editor", "viewer"]);

export const inviteGuestRequestSchema = z.object({
  email: z.string().email(),
  role: guestRoleSchema,
});

export const workspaceGuestSchema = z.object({
  userId: z.string(),
  role: guestRoleSchema,
  name: z.string().nullable(),
  email: z.string().nullable(),
  image: z.string().nullable(),
  createdAt: z.string(),
});

export const pendingGuestInvitationSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: guestRoleSchema,
  createdAt: z.string(),
});

export const listWorkspaceGuestsResponseSchema = z.object({
  guests: z.array(workspaceGuestSchema),
  invitations: z.array(pendingGuestInvitationSchema),
});

export const acceptGuestInvitationRequestSchema = z.object({
  token: z.string().min(1),
});

export const acceptGuestInvitationResponseSchema = z.object({
  workspaceId: z.string(),
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
export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;
export type WorkspaceMember = z.infer<typeof workspaceMemberSchema>;
export type ListWorkspaceMembersResponse = z.infer<
  typeof listWorkspaceMembersResponseSchema
>;
export type AddWorkspaceMemberRequest = z.infer<
  typeof addWorkspaceMemberRequestSchema
>;
export type UpdateWorkspaceMemberRoleRequest = z.infer<
  typeof updateWorkspaceMemberRoleRequestSchema
>;
export type WorkspaceMemberMutationResponse = z.infer<
  typeof workspaceMemberMutationResponseSchema
>;
export type TeamAuditLog = z.infer<typeof teamAuditLogSchema>;
export type ListTeamAuditLogsResponse = z.infer<
  typeof listTeamAuditLogsResponseSchema
>;
export type GuestRole = z.infer<typeof guestRoleSchema>;
export type InviteGuestRequest = z.infer<typeof inviteGuestRequestSchema>;
export type WorkspaceGuest = z.infer<typeof workspaceGuestSchema>;
export type PendingGuestInvitation = z.infer<
  typeof pendingGuestInvitationSchema
>;
export type ListWorkspaceGuestsResponse = z.infer<
  typeof listWorkspaceGuestsResponseSchema
>;
export type AcceptGuestInvitationRequest = z.infer<
  typeof acceptGuestInvitationRequestSchema
>;
export type AcceptGuestInvitationResponse = z.infer<
  typeof acceptGuestInvitationResponseSchema
>;
