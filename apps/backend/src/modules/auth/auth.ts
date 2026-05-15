import { betterAuth } from "better-auth";
import {
  bearer,
  emailOTP,
  jwt,
  magicLink,
  multiSession,
  oneTimeToken,
  oneTap,
  organization,
  twoFactor,
  username,
} from "better-auth/plugins";
import { apiKey } from "@better-auth/api-key";
import { creem } from "@creem_io/better-auth";
import { oauthProvider } from "@better-auth/oauth-provider";
import { passkey } from "@better-auth/passkey";
import { APIError } from "better-auth/api";
import { config } from "../../shared/config";
import { database } from "../../shared/database";
import { logger } from "../../shared/logger";
import { mailService } from "../../shared/mail";
import { onboardingService } from "../onboarding";
import { billingService, syncCreemSubscriptionEvent } from "../billing";
import { workspaceService } from "../workspace";
import {
  isPersonalOrganizationMetadata,
  parseSourceweftOrganizationKind,
  withSourceweftOrganizationKind,
} from "./organization-metadata";

function withBaseUrl(path: string) {
  const base = config.auth.baseUrl.replace(/\/$/, "");
  if (path.startsWith("http://") || path.startsWith("https://")) {
    return path;
  }

  return `${base}${path.startsWith("/") ? "" : "/"}${path}`;
}

const socialProviders: Record<string, unknown> = {};

if (config.auth.googleClientId && config.auth.googleClientSecret) {
  socialProviders.google = {
    clientId: config.auth.googleClientId,
    clientSecret: config.auth.googleClientSecret,
    prompt: "select_account",
  };
}

if (config.auth.githubClientId && config.auth.githubClientSecret) {
  socialProviders.github = {
    clientId: config.auth.githubClientId,
    clientSecret: config.auth.githubClientSecret,
    scope: ["read:user", "user:email"],
  };
}

type SoleOwnerOrganizationRow = {
  organization_id: string;
  organization_name: string | null;
};

async function assertUserHardDeleteAllowed(userId: string) {
  const result = await database.query<SoleOwnerOrganizationRow>(
    `
      select
        m."organizationId" as organization_id,
        o.name as organization_name
      from member m
      left join organization o on o.id = m."organizationId"
      where m."userId" = $1
        and m.role = 'owner'
        and (
          select count(*)
          from member m2
          where m2."organizationId" = m."organizationId"
            and m2.role = 'owner'
        ) = 1
      limit 1
    `,
    [userId],
  );

  const row = result.rows?.[0];
  if (!row) {
    return;
  }

  const organizationLabel = row.organization_name || row.organization_id;
  throw new APIError("BAD_REQUEST", {
    message: `Transfer the owner role for organization '${organizationLabel}' before deleting this account.`,
  });
}

async function syncOrganizationSeatsAfterMembershipChange(input: {
  organizationId: string;
  actorUserId?: string | null;
  reason: string;
}) {
  try {
    await billingService.syncTeamSubscriptionSeatsToMembers(
      input.organizationId,
      {
        actorUserId: input.actorUserId ?? null,
        reason: input.reason,
      },
    );
  } catch (error) {
    logger.error("Failed to sync billing seats after membership change", {
      organizationId: input.organizationId,
      reason: input.reason,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export const auth: any = betterAuth({
  appName: "SourceWeft",
  baseURL: config.auth.baseUrl,
  secret: config.auth.secret,
  logger: {
    level: (process.env.BETTER_AUTH_LOG_LEVEL as
      | "debug"
      | "info"
      | "warn"
      | "error"
      | undefined) || "info",
    log: (level, message, ...args) => {
      const meta = args.length > 0 ? { args } : undefined;
      if (level === "debug") {
        logger.debug(`[BetterAuth] ${message}`, meta);
        return;
      }
      if (level === "info") {
        logger.info(`[BetterAuth] ${message}`, meta);
        return;
      }
      if (level === "warn") {
        logger.warn(`[BetterAuth] ${message}`, meta);
        return;
      }
      logger.error(`[BetterAuth] ${message}`, meta);
    },
  },
  onAPIError: {
    errorURL: config.auth.errorUrl,
  },
  silenceWarnings: {
    oauthAuthServerConfig: true,
  },
  database,
  trustedOrigins: config.auth.trustedOrigins,
  socialProviders,
  user: {
    additionalFields: {
      company: {
        type: "string",
        required: false,
      },
      role: {
        type: "string",
        required: false,
      },
      timezone: {
        type: "string",
        required: false,
      },
      bio: {
        type: "string",
        required: false,
      },
    },
    changeEmail: {
      enabled: false,
    },
    deleteUser: {
      enabled: true,
      async beforeDelete(user) {
        await assertUserHardDeleteAllowed(user.id);
      },
      async sendDeleteAccountVerification(data) {
        await mailService.sendTemplate({
          to: data.user.email,
          templateId: "auth.delete-account",
          messageType: "auth.delete-account",
          variables: {
            url: data.url,
          },
        });
      },
    },
  },
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
    async sendResetPassword(data) {
      await mailService.sendTemplate({
        to: data.user.email,
        templateId: "auth.reset-password",
        messageType: "auth.reset-password",
        variables: {
          url: data.url,
        },
      });
    },
  },
  emailVerification: {
    sendOnSignUp: false,
    async sendVerificationEmail(data) {
      await mailService.sendTemplate({
        to: data.user.email,
        templateId: "auth.verify-email",
        messageType: "auth.verify-email",
        variables: {
          url: data.url,
        },
      });
    },
  },
  rateLimit: {
    enabled: true,
    window: 10,
    max: 100,
    customRules: {
      "/api/auth/sign-in/email": {
        window: 60,
        max: 6,
      },
      "/api/auth/sign-up/email": {
        window: 60,
        max: 4,
      },
      "/api/auth/email-otp/send-verification-otp": {
        window: 60,
        max: 6,
      },
      "/api/auth/organization/invite-member": {
        window: 60,
        max: 10,
      },
    },
  },
  plugins: [
    username(),
    organization({
      async sendInvitationEmail(data) {
        await mailService.sendTemplate({
          to: data.email,
          templateId: "org.invitation",
          messageType: "org.invitation",
          variables: {
            inviterLabel: data.inviter.user.name || data.inviter.user.email,
            organizationName: data.organization.name,
            url: withBaseUrl(
              `/auth/accept-invitation?invitationId=${encodeURIComponent(data.id)}`,
            ),
          },
        });
      },
      organizationHooks: {
        async beforeCreateOrganization({ organization }) {
          return {
            data: {
              ...organization,
              metadata: withSourceweftOrganizationKind(
                organization.metadata,
                "team",
              ),
            },
          };
        },
        async beforeUpdateOrganization({ organization, member }) {
          const existing = await workspaceService.getOrganization(
            member.organizationId,
          );

          if (!existing) {
            throw new APIError("BAD_REQUEST", {
              message: "Organization not found.",
            });
          }

          const existingKind = parseSourceweftOrganizationKind(
            existing.metadata,
          );

          if (organization.metadata !== undefined) {
            const nextKind = parseSourceweftOrganizationKind(
              organization.metadata,
            );

            if (nextKind !== existingKind) {
              throw new APIError("BAD_REQUEST", {
                message: "Organization type cannot be changed.",
              });
            }
          }

          if (existingKind !== "personal") {
            return { data: organization };
          }

          if (organization.name !== undefined || organization.slug !== undefined) {
            throw new APIError("BAD_REQUEST", {
              message: "Personal workspace cannot be renamed.",
            });
          }

          if (
            organization.metadata !== undefined &&
            !isPersonalOrganizationMetadata(organization.metadata)
          ) {
            throw new APIError("BAD_REQUEST", {
              message: "Personal workspace type cannot be changed.",
            });
          }

          return { data: organization };
        },
        async beforeAddMember({ organization }) {
          if (isPersonalOrganizationMetadata(organization.metadata)) {
            throw new APIError("BAD_REQUEST", {
              message: "Personal workspace cannot add members.",
            });
          }

          await billingService.assertCanAddTeamMember(organization.id);
        },
        async beforeCreateInvitation({ organization }) {
          if (isPersonalOrganizationMetadata(organization.metadata)) {
            throw new APIError("BAD_REQUEST", {
              message: "Personal workspace cannot invite members.",
            });
          }

          await billingService.assertCanInviteTeamMember(organization.id);
        },
        async beforeAcceptInvitation({ organization }) {
          if (isPersonalOrganizationMetadata(organization.metadata)) {
            throw new APIError("BAD_REQUEST", {
              message: "Personal workspace cannot accept invitations.",
            });
          }

          await billingService.assertCanAcceptTeamInvitation(organization.id);
        },
        async beforeDeleteOrganization({ organization }) {
          if (isPersonalOrganizationMetadata(organization.metadata)) {
            throw new APIError("BAD_REQUEST", {
              message: "Personal workspace cannot be deleted.",
            });
          }
        },
        async afterCreateOrganization({ organization, user }) {
          await onboardingService.provisionOrganization({
            organizationId: organization.id,
            userId: user.id,
          });
        },
        async afterAddMember({ organization, user }) {
          await syncOrganizationSeatsAfterMembershipChange({
            organizationId: organization.id,
            actorUserId: user.id,
            reason: "member_added",
          });
        },
        async afterRemoveMember({ organization, user }) {
          await syncOrganizationSeatsAfterMembershipChange({
            organizationId: organization.id,
            actorUserId: user.id,
            reason: "member_removed",
          });
        },
        async afterAcceptInvitation({ organization, user }) {
          await syncOrganizationSeatsAfterMembershipChange({
            organizationId: organization.id,
            actorUserId: user.id,
            reason: "invitation_accepted",
          });
        },
      },
    }),
    twoFactor({
      issuer: "SourceWeft",
      otpOptions: {
        async sendOTP({ user, otp }) {
          await mailService.sendTemplate({
            to: user.email,
            templateId: "auth.two-factor-otp",
            messageType: "auth.two-factor-otp",
            variables: {
              otp,
            },
          });
        },
      },
    }),
    multiSession({
      maximumSessions: 8,
    }),
    apiKey([
      {
        configId: "user",
        references: "user",
        defaultPrefix: "vmu_",
        enableMetadata: true,
        requireName: true,
      },
      {
        configId: "organization",
        references: "organization",
        defaultPrefix: "vmo_",
        enableMetadata: true,
        requireName: true,
      },
    ]),
    ...(config.billing.provider === "creem"
      ? [
          creem({
            apiKey: config.billing.creem.apiKey,
            webhookSecret: config.billing.creem.webhookSecret || undefined,
            testMode: config.billing.creem.testMode,
            defaultSuccessUrl: config.billing.defaultSuccessUrl,
            persistSubscriptions: true,
            onSubscriptionActive: async (data) => {
              await syncCreemSubscriptionEvent(
                "subscription.active",
                data,
                "active",
              );
            },
            onSubscriptionTrialing: async (data) => {
              await syncCreemSubscriptionEvent(
                "subscription.trialing",
                data,
                "trialing",
              );
            },
            onSubscriptionPaid: async (data) => {
              await syncCreemSubscriptionEvent(
                "subscription.paid",
                data,
                "active",
              );
            },
            onSubscriptionPastDue: async (data) => {
              await syncCreemSubscriptionEvent(
                "subscription.past_due",
                data,
                "past_due",
              );
            },
            onSubscriptionPaused: async (data) => {
              await syncCreemSubscriptionEvent(
                "subscription.paused",
                data,
                "paused",
              );
            },
            onSubscriptionUnpaid: async (data) => {
              await syncCreemSubscriptionEvent(
                "subscription.unpaid",
                data,
                "unpaid",
              );
            },
            onSubscriptionCanceled: async (data) => {
              await syncCreemSubscriptionEvent(
                "subscription.canceled",
                data,
                "canceled",
              );
            },
            onSubscriptionExpired: async (data) => {
              await syncCreemSubscriptionEvent(
                "subscription.expired",
                data,
                "expired",
              );
            },
            onSubscriptionUpdate: async (data) => {
              await syncCreemSubscriptionEvent(
                "subscription.update",
                data,
                "active",
              );
            },
          }),
        ]
      : []),
    ...(config.auth.oneTapClientId || config.auth.googleClientId
      ? [
          oneTap({
            clientId: config.auth.oneTapClientId || config.auth.googleClientId,
          }),
        ]
      : []),
    emailOTP({
      sendVerificationOnSignUp: false,
      allowedAttempts: 5,
      resendStrategy: "reuse",
      async sendVerificationOTP({ email, otp, type }) {
        const templateType =
          type === "email-verification" || type === "forget-password"
            ? type
            : "sign-in";

        await mailService.sendTemplate({
          to: email,
          templateId: `auth.email-otp.${templateType}`,
          messageType: "auth.email-otp",
          variables: {
            otp,
            type,
          },
        });
      },
    }),
    magicLink({
      async sendMagicLink({ email, url }) {
        await mailService.sendTemplate({
          to: email,
          templateId: "auth.magic-link",
          messageType: "auth.magic-link",
          variables: {
            url,
          },
        });
      },
    }),
    oneTimeToken({
      expiresIn: 1,
      storeToken: "hashed",
    }),
    passkey({
      rpID: config.auth.passkey.rpId,
      rpName: config.auth.passkey.rpName,
      origin: config.auth.passkey.origin,
    }),
    jwt(),
    bearer({
      requireSignature: true,
    }),
    oauthProvider({
      loginPage: "/auth/login",
      consentPage: "/auth/consent",
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      validAudiences: [config.auth.baseUrl],
      scopes: ["openid", "profile", "email", "offline_access"],
      cachedTrustedClients: new Set([config.auth.extensionClientId]),
    }),
  ],
  databaseHooks: {
    session: {
      create: {
        after: async (session) => {
          await onboardingService.ensurePersonalTeamForUser({
            userId: session.userId,
          });
        },
      },
    },
  },
});

export async function getSession(headers: Headers) {
  return auth.api.getSession({ headers });
}
