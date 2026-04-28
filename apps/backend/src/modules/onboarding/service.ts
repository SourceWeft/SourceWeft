import { randomUUID } from "node:crypto";
import { billingService } from "../billing";
import { workspaceService } from "../workspace";

type CreateOrganization = (input: {
  body: {
    name: string;
    slug: string;
    userId: string;
  };
}) => Promise<{ id: string }>;

export class OnboardingService {
  async provisionOrganization(input: { organizationId: string; userId: string }) {
    await workspaceService.ensureDefaultWorkspace(input);
    await billingService.ensureBillingAccount(input.organizationId);
  }

  async ensurePersonalTeamForUser(input: {
    userId: string;
    createOrganization: CreateOrganization;
  }) {
    const existing = await workspaceService.findAnyMembershipByUser(input.userId);
    if (existing) {
      return null;
    }

    const created = await input.createOrganization({
      body: {
        name: "Personal",
        slug: `personal-${randomUUID().slice(0, 8)}`,
        userId: input.userId,
      },
    });

    await this.provisionOrganization({
      organizationId: created.id,
      userId: input.userId,
    });

    return { organizationId: created.id };
  }
}

export const onboardingService = new OnboardingService();
