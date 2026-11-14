import type { WorkspaceAccess } from "../workspace/types";

export type GuidePayer = {
  /** The person whose credits are charged. */
  userId: string;
  /** The organization that person's usage is settled against. */
  billingOrganizationId: string;
};

export type GuidePayerPorts = {
  resolveAccess: (input: {
    workspaceId: string;
    userId: string;
  }) => Promise<WorkspaceAccess | null>;
  resolveResponsibleUserId: (input: {
    workspaceId: string;
    organizationId: string;
  }) => Promise<string | null>;
  resolveBillingOrganizationId: (input: {
    workspaceId: string;
    userId: string;
    workspaceOrganizationId: string;
  }) => Promise<string>;
};

/**
 * Who pays for a guide.
 *
 * A person who added the source or asked for the guide pays. With nobody in
 * the loop (a system-initiated run) the workspace's responsible owner pays.
 * Someone who no longer has access to the workspace is never charged, and
 * neither is anyone else in their place: the result is null and the guide
 * waits.
 */
export async function resolveGuidePayer(
  input: {
    workspaceId: string;
    organizationId: string;
    initiatorUserId?: string | null;
  },
  ports: GuidePayerPorts,
): Promise<GuidePayer | null> {
  const userId =
    input.initiatorUserId ??
    (await ports.resolveResponsibleUserId({
      workspaceId: input.workspaceId,
      organizationId: input.organizationId,
    }));
  if (!userId) return null;

  const access = await ports.resolveAccess({
    workspaceId: input.workspaceId,
    userId,
  });
  if (!access) return null;

  return {
    userId,
    billingOrganizationId: await ports.resolveBillingOrganizationId({
      workspaceId: input.workspaceId,
      userId,
      workspaceOrganizationId: input.organizationId,
    }),
  };
}
