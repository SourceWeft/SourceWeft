import { Hono } from "hono";
import {
  createPricingCheckoutRequestSchema,
  createTeamSubscriptionCheckoutRequestSchema,
  createTopupCheckoutRequestSchema,
  meterConsumeRequestSchema,
  meterIngestionRequestSchema,
  updateTeamSubscriptionSeatsRequestSchema,
  updateSpendLimitsRequestSchema,
} from "@sourceweft/contracts";
import { billingService } from "../../modules/billing";
import { onboardingService } from "../../modules/onboarding";
import { workspaceService } from "../../modules/workspace";
import type { OrganizationMembership } from "../../modules/workspace";
import { isPersonalOrganizationMetadata } from "../../modules/auth/organization-metadata";
import { getSessionUserId, requireSession } from "../middleware/auth-session";
import { ApiError, ApiResponse } from "../response/api-response";

function canManageBilling(role: string) {
  return role === "owner" || role === "admin" || role === "billing_admin";
}

function ensureObjectBody(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw ApiError.invalidJson();
  }

  return value;
}

function parseLedgerLimit(rawLimit: string | undefined) {
  const limit = rawLimit ? Number(rawLimit) : 50;
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new ApiError(400, "INVALID_LIMIT", "limit must be a positive number");
  }

  return Math.floor(limit);
}

async function requireTeamMembership(
  teamId: string,
  userId: string,
  options?: { requireBillingManager?: boolean },
): Promise<OrganizationMembership> {
  const membership = await workspaceService.getOrganizationMembership({
    organizationId: teamId,
    userId,
  });

  if (!membership) {
    throw ApiError.forbidden();
  }

  if (options?.requireBillingManager && !canManageBilling(membership.role)) {
    throw ApiError.forbidden();
  }

  return membership;
}

async function requirePlanMatchesOrganization(
  teamId: string,
  planFamily: "individual_pro" | "team_standard",
) {
  const organization = await workspaceService.getOrganization(teamId);
  if (!organization) {
    throw ApiError.notFound("Organization not found");
  }

  const isPersonal = isPersonalOrganizationMetadata(organization.metadata);

  if (planFamily === "individual_pro" && !isPersonal) {
    throw new ApiError(
      400,
      "PLAN_SCOPE_MISMATCH",
      "individual_pro checkout is only available for personal billing",
    );
  }

  if (planFamily === "team_standard" && isPersonal) {
    throw new ApiError(
      400,
      "PLAN_SCOPE_MISMATCH",
      "team_standard checkout is only available for team billing",
    );
  }
}

export function registerBillingRoutes(app: Hono) {
  app.post("/v1/billing/pricing/checkout", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const userId = getSessionUserId(session);
    const body = ensureObjectBody(await c.req.json().catch(() => null));
    const parsed = createPricingCheckoutRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    let personalTeamId: string | null = null;
    if (parsed.data.plan === "pro") {
      await onboardingService.ensurePersonalTeamForUser({ userId });
      const personalMembership =
        await workspaceService.findPersonalOrganizationMembershipByUser(userId);
      personalTeamId = personalMembership?.organizationId ?? null;
    }

    const response = await billingService.createPricingCheckout(
      parsed.data,
      {
        userId,
        email: session.user.email,
      },
      { personalTeamId },
    );

    return ApiResponse.success(c, response);
  });

  app.get("/v1/billing/orders/:orderId", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const order = await billingService.getOrder(c.req.param("orderId"));
    if (!order) {
      throw ApiError.notFound("Billing order not found");
    }

    const userId = getSessionUserId(session);
    if (order.userId !== userId) {
      if (!order.teamId) {
        throw ApiError.forbidden();
      }

      await requireTeamMembership(order.teamId, userId, {
        requireBillingManager: true,
      });
    }

    return ApiResponse.success(c, order);
  });

  app.get("/v1/teams/:teamId/billing/summary", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const teamId = c.req.param("teamId");
    const userId = getSessionUserId(session);
    await requireTeamMembership(teamId, userId);

    const summary = await billingService.getSummary(teamId);
    return ApiResponse.success(c, summary);
  });

  app.get("/v1/teams/:teamId/billing/usage", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const teamId = c.req.param("teamId");
    const userId = getSessionUserId(session);
    await requireTeamMembership(teamId, userId);

    const usage = await billingService.getUsage(teamId);
    return ApiResponse.success(c, usage);
  });

  app.get("/v1/teams/:teamId/billing/ledger", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const teamId = c.req.param("teamId");
    const userId = getSessionUserId(session);
    await requireTeamMembership(teamId, userId);

    const limit = parseLedgerLimit(c.req.query("limit"));
    const activityOnly = c.req.query("activity") === "true";
    const ledger = await billingService.getLedger(teamId, limit, {
      activityOnly,
    });
    return ApiResponse.success(c, ledger);
  });

  app.get("/v1/teams/:teamId/billing/activity", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const teamId = c.req.param("teamId");
    const userId = getSessionUserId(session);
    await requireTeamMembership(teamId, userId);

    const limit = parseLedgerLimit(c.req.query("limit"));
    const ledger = await billingService.getLedger(teamId, limit, {
      activityOnly: true,
    });
    return ApiResponse.success(c, ledger);
  });

  app.get("/v1/teams/:teamId/billing/subscription", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const teamId = c.req.param("teamId");
    const userId = getSessionUserId(session);
    await requireTeamMembership(teamId, userId);

    const response = await billingService.getSubscription(teamId);
    return ApiResponse.success(c, response);
  });

  app.post("/v1/teams/:teamId/billing/spend-limits", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const teamId = c.req.param("teamId");
    const userId = getSessionUserId(session);
    await requireTeamMembership(teamId, userId, {
      requireBillingManager: true,
    });

    const body = ensureObjectBody(await c.req.json().catch(() => null));
    const parsed = updateSpendLimitsRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    const response = await billingService.updateSpendLimits(
      teamId,
      parsed.data,
    );
    return ApiResponse.success(c, response);
  });

  app.post("/v1/teams/:teamId/billing/topups/checkout", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const teamId = c.req.param("teamId");
    const userId = getSessionUserId(session);
    await requireTeamMembership(teamId, userId, {
      requireBillingManager: true,
    });

    const body = ensureObjectBody(await c.req.json().catch(() => null));
    const parsed = createTopupCheckoutRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    const response = await billingService.createTopupCheckout(
      teamId,
      parsed.data,
      userId,
      session.user.email,
    );
    return ApiResponse.success(c, response);
  });

  app.post("/v1/teams/:teamId/billing/subscription/checkout", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const teamId = c.req.param("teamId");
    const userId = getSessionUserId(session);
    await requireTeamMembership(teamId, userId, {
      requireBillingManager: true,
    });

    const body = ensureObjectBody(await c.req.json().catch(() => null));
    const parsed = createTeamSubscriptionCheckoutRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    await requirePlanMatchesOrganization(teamId, parsed.data.planFamily);

    const response = await billingService.createSubscriptionCheckout(
      teamId,
      parsed.data,
      {
        userId,
        email: session.user.email,
      },
    );

    return ApiResponse.success(c, response);
  });

  app.post("/v1/teams/:teamId/billing/subscription/seats", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const teamId = c.req.param("teamId");
    const userId = getSessionUserId(session);
    await requireTeamMembership(teamId, userId, {
      requireBillingManager: true,
    });

    const organization = await workspaceService.getOrganization(teamId);
    if (!organization) {
      throw ApiError.notFound("Organization not found");
    }

    if (isPersonalOrganizationMetadata(organization.metadata)) {
      throw new ApiError(
        400,
        "PLAN_SCOPE_MISMATCH",
        "Seat updates are only available for team billing",
      );
    }

    const body = ensureObjectBody(await c.req.json().catch(() => null));
    const parsed = updateTeamSubscriptionSeatsRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    const response = await billingService.syncTeamSubscriptionSeats(teamId, {
      ...parsed.data,
      actorUserId: userId,
      reason: "user_requested",
    });
    return ApiResponse.success(c, response);
  });

  app.post(
    "/v1/teams/:teamId/billing/subscription/seats/preview",
    async (c) => {
      const session = await requireSession(c);
      if (!session) {
        throw ApiError.unauthorized();
      }

      const teamId = c.req.param("teamId");
      const userId = getSessionUserId(session);
      await requireTeamMembership(teamId, userId, {
        requireBillingManager: true,
      });

      const organization = await workspaceService.getOrganization(teamId);
      if (!organization) {
        throw ApiError.notFound("Organization not found");
      }

      if (isPersonalOrganizationMetadata(organization.metadata)) {
        throw new ApiError(
          400,
          "PLAN_SCOPE_MISMATCH",
          "Seat updates are only available for team billing",
        );
      }

      const body = ensureObjectBody(await c.req.json().catch(() => null));
      const parsed = updateTeamSubscriptionSeatsRequestSchema.safeParse(body);
      if (!parsed.success) {
        throw ApiError.validation(
          parsed.error.flatten() as Record<string, unknown>,
        );
      }

      const response = await billingService.previewTeamSubscriptionSeats(
        teamId,
        parsed.data,
      );
      return ApiResponse.success(c, response);
    },
  );

  app.post("/v1/teams/:teamId/billing/subscription/portal", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const teamId = c.req.param("teamId");
    const userId = getSessionUserId(session);
    await requireTeamMembership(teamId, userId, {
      requireBillingManager: true,
    });

    const response = await billingService.createBillingPortal(teamId, userId);
    return ApiResponse.success(c, response);
  });

  app.post("/v1/teams/:teamId/billing/subscription/cancel", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const teamId = c.req.param("teamId");
    const userId = getSessionUserId(session);
    await requireTeamMembership(teamId, userId, {
      requireBillingManager: true,
    });

    const response = await billingService.cancelSubscription(teamId, userId);
    return ApiResponse.success(c, response);
  });

  app.post("/v1/teams/:teamId/billing/meter/consume", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const teamId = c.req.param("teamId");
    const userId = getSessionUserId(session);
    await requireTeamMembership(teamId, userId, {
      requireBillingManager: true,
    });

    const body = ensureObjectBody(await c.req.json().catch(() => null));
    const parsed = meterConsumeRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    const response = await billingService.meterConsume(
      teamId,
      parsed.data,
      userId,
    );
    return ApiResponse.success(c, response);
  });

  app.post("/v1/teams/:teamId/billing/meter/ingestion", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const teamId = c.req.param("teamId");
    const userId = getSessionUserId(session);
    await requireTeamMembership(teamId, userId, {
      requireBillingManager: true,
    });

    const body = ensureObjectBody(await c.req.json().catch(() => null));
    const parsed = meterIngestionRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    const response = await billingService.meterIngestion(
      teamId,
      parsed.data,
      userId,
    );
    return ApiResponse.success(c, response);
  });
}
