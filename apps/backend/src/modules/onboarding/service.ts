import { randomUUID } from "node:crypto";
import { createSourceweftOrganizationMetadata } from "../auth/organization-metadata";
import { billingOrganizationHooks as billingService } from "../../billing-host/bindings";
import { workspaceService } from "../workspace";

export class OnboardingService {
  async provisionOrganization(input: {
    organizationId: string;
    userId: string;
  }) {
    await workspaceService.ensureMembershipWorkspace(input);
    await billingService.provisionAccount(input.organizationId, input.userId);
  }

  async ensurePersonalTeamForUser(input: { userId: string }) {
    const existingPersonal =
      await workspaceService.findPersonalOrganizationMembershipByUser(
        input.userId,
      );
    if (existingPersonal) {
      return null;
    }

    let created: { created: boolean; id: string } | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        created = await workspaceService.createPersonalOrganization({
          name: "Personal",
          slug: `personal-${randomUUID().slice(0, 8)}`,
          userId: input.userId,
          metadata: createSourceweftOrganizationMetadata("personal"),
        });
        break;
      } catch (error) {
        const pgError = error as { code?: string };
        if (pgError.code !== "23505" || attempt === 2) {
          throw error;
        }
      }
    }

    if (!created) {
      throw new Error("Failed to create personal organization");
    }

    if (created.created) {
      await this.provisionOrganization({
        organizationId: created.id,
        userId: input.userId,
      });
    }

    return { organizationId: created.id };
  }
}

export const onboardingService = new OnboardingService();
