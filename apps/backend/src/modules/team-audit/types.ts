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
  | "thread.shared"
  | "thread.share_updated"
  | "thread.share_revoked"
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
  | "agent_task.run_requested"
  // Workspace assistant (#692). `actorUserId` is always the admin who acted;
  // the platform never changes these on its own in this task (Task 7 adds
  // the steward-left pause, with actor null).
  | "assistant.enabled"
  | "assistant.paused"
  | "assistant.resumed"
  | "assistant.steward_changed";

export type TeamAuditTargetType =
  | "skill"
  | "workspace"
  | "workspace_member"
  | "member"
  | "artifact"
  | "thread"
  | "guest"
  | "sso_provider"
  | "agent_task"
  | "assistant";

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
