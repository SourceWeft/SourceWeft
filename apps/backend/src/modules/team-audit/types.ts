/**
 * Actions recorded in `team_audit_logs`. The list is closed on purpose: an
 * audit trail whose vocabulary drifts per call site cannot be queried.
 */
export type TeamAuditAction =
  | "skill.version_changed"
  | "workspace.created"
  | "workspace.renamed"
  | "workspace.member_added"
  | "workspace.member_role_changed"
  | "workspace.member_removed"
  | "organization.member_added"
  | "organization.member_removed"
  | "organization.member_role_changed"
  | "organization.invitation_accepted"
  | "artifact.shared"
  | "artifact.share_revoked"
  | "artifact.deleted"
  | "artifact.storage_shared_approved"
  | "artifact.storage_shared_revoked"
  | "artifact.page_navigation_attempt"
  | "artifact.records_exported"
  | "artifact.records_cleared"
  | "workspace.guest_invited"
  | "workspace.guest_accepted"
  | "workspace.guest_revoked"
  | "workspace.guest_removed"
  | "sso.provider_created"
  | "sso.provider_updated"
  | "sso.provider_deleted"
  | "sso.domain_verified"
  | "sso.sign_in"
  // Scheduled tasks. `actorUserId` is the owner for what they did themselves
  // and null for what the platform did to the task (blocked, paused, resumed).
  | "agent_task.created"
  | "agent_task.updated"
  | "agent_task.activated"
  | "agent_task.paused"
  | "agent_task.resumed"
  | "agent_task.blocked"
  | "agent_task.deleted"
  | "agent_task.run_requested";

export type TeamAuditTargetType =
  | "skill"
  | "workspace"
  | "workspace_member"
  | "member"
  | "artifact"
  | "guest"
  | "sso_provider"
  | "agent_task";

export type TeamAuditEntry = {
  teamId: string;
  actorUserId: string | null;
  action: TeamAuditAction;
  targetType: TeamAuditTargetType;
  targetId: string | null;
  metadata?: Record<string, unknown>;
};

export type TeamAuditLog = TeamAuditEntry & {
  id: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};
