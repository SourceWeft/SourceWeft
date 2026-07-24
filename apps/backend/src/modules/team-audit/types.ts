/**
 * Actions recorded in `team_audit_logs`. The list is closed on purpose: an
 * audit trail whose vocabulary drifts per call site cannot be queried.
 */
export type TeamAuditAction =
  | "workspace.created"
  | "workspace.renamed"
  | "workspace.member_added"
  | "workspace.member_role_changed"
  | "workspace.member_removed"
  | "organization.member_added"
  | "organization.member_removed"
  | "organization.member_role_changed"
  | "organization.invitation_accepted";

export type TeamAuditTargetType = "workspace" | "workspace_member" | "member";

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
