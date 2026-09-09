import type { Context } from "hono";

type Session = { user: { id: string; email: string } };
type HttpError = Error & {
  code: string;
  statusCode: number;
  details?: Record<string, unknown>;
};

export interface BillingHttpHost {
  requireSession(context: Context): Promise<Session | null>;
  getSessionUserId(session: Session): string;
  isPersonalOrganizationMetadata(metadata: unknown): boolean;
  workspaceService: {
    getOrganizationMembership(input: {
      organizationId: string;
      userId: string;
    }): Promise<{ role: string } | null>;
    getOrganization(teamId: string): Promise<{ metadata?: unknown } | null>;
    findPersonalOrganizationMembershipByUser(
      userId: string,
    ): Promise<{ organizationId: string } | null>;
  };
  onboardingService: {
    ensurePersonalTeamForUser(input: { userId: string }): Promise<unknown>;
  };
  ApiError: {
    new (
      status: number,
      code: string,
      message: string,
      details?: Record<string, unknown>,
    ): HttpError;
    unauthorized(message?: string): HttpError;
    forbidden(message?: string): HttpError;
    notFound(message?: string): HttpError;
    invalidJson(message?: string): HttpError;
    validation(details?: Record<string, unknown>): HttpError;
  };
  ApiResponse: {
    success(context: Context, data: unknown): Response;
  };
}
