import { workspaceService } from "../workspace";

export type LlmObservabilityAccess = {
  teamId: string;
  workspaceId?: string;
  actorUserId: string;
  role: string;
  payloadAccess: boolean;
  metricsOnly: boolean;
};

function isOrgAdminRole(role: string) {
  return role === "owner" || role === "admin";
}

function isBillingAdminRole(role: string) {
  return role === "billing_admin";
}

export async function resolveWorkspaceObservabilityAccess(input: {
  workspaceId: string;
  actorUserId: string;
}): Promise<LlmObservabilityAccess | null> {
  const workspace = await workspaceService.resolveWorkspace({
    workspaceId: input.workspaceId,
    userId: input.actorUserId,
  });
  if (!workspace) {
    return null;
  }

  const orgMembership = await workspaceService.getOrganizationMembership({
    organizationId: workspace.organizationId,
    userId: input.actorUserId,
  });
  if (orgMembership && isOrgAdminRole(orgMembership.role)) {
    return {
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      actorUserId: input.actorUserId,
      role: orgMembership.role,
      payloadAccess: true,
      metricsOnly: false,
    };
  }

  if (orgMembership && isBillingAdminRole(orgMembership.role)) {
    return {
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      actorUserId: input.actorUserId,
      role: orgMembership.role,
      payloadAccess: false,
      metricsOnly: true,
    };
  }

  // Payload access is content access, so it is judged on the content plane
  // only: an organization admin gets the metrics-only branch above, never the
  // branch that reads what members actually sent.
  const workspaceAccess = await workspaceService.resolveAccess({
    workspaceId: workspace.id,
    userId: input.actorUserId,
  });
  if (workspaceAccess?.role !== "workspace_admin") {
    return null;
  }

  return {
    teamId: workspace.organizationId,
    workspaceId: workspace.id,
    actorUserId: input.actorUserId,
    role: workspaceAccess.role,
    payloadAccess: true,
    metricsOnly: false,
  };
}

export async function resolveTeamObservabilityAccess(input: {
  teamId: string;
  actorUserId: string;
}): Promise<LlmObservabilityAccess | null> {
  const orgMembership = await workspaceService.getOrganizationMembership({
    organizationId: input.teamId,
    userId: input.actorUserId,
  });
  if (!orgMembership) {
    return null;
  }

  if (isOrgAdminRole(orgMembership.role)) {
    return {
      teamId: input.teamId,
      actorUserId: input.actorUserId,
      role: orgMembership.role,
      payloadAccess: true,
      metricsOnly: false,
    };
  }

  if (isBillingAdminRole(orgMembership.role)) {
    return {
      teamId: input.teamId,
      actorUserId: input.actorUserId,
      role: orgMembership.role,
      payloadAccess: false,
      metricsOnly: true,
    };
  }

  return null;
}
