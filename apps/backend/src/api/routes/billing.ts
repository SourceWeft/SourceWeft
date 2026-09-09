import type { Hono } from "hono";
import { registerBillingHttpRoutes } from "../../billing-host/bindings";
import { workspaceService } from "../../modules/workspace";
import { onboardingService } from "../../modules/onboarding";
import { isPersonalOrganizationMetadata } from "../../modules/auth/organization-metadata";
import { requireSession, getSessionUserId } from "../middleware/auth-session";
import { ApiError, ApiResponse } from "../response/api-response";
export function registerBillingRoutes(app: Hono) {
  registerBillingHttpRoutes(app, {
    workspaceService,
    onboardingService,
    isPersonalOrganizationMetadata,
    async requireSession(c) {
      const session = await requireSession(c);
      return session
        ? {
            user: {
              id: getSessionUserId(session),
              email: session.user.email as string,
            },
          }
        : null;
    },
    getSessionUserId: (session) => session.user.id,
    ApiError,
    ApiResponse,
  });
}
