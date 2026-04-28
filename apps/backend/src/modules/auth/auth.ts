import { betterAuth } from "better-auth";
import {
  bearer,
  emailOTP,
  jwt,
  magicLink,
  multiSession,
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
import { syncCreemSubscriptionEvent } from "../billing";
import { renderLinkTemplate, renderOtpTemplate } from "./templates";

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
        await mailService.send({
          to: data.user.email,
          subject: "Confirm account deletion",
          html: renderLinkTemplate({
            title: "Confirm account deletion",
            message:
              "We received a request to delete your SourceWeft account. This action is permanent.",
            buttonLabel: "Delete account",
            buttonUrl: data.url,
          }),
          templateId: "auth.delete-account",
          messageType: "auth.delete-account",
        });
      },
    },
  },
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
    async sendResetPassword(data) {
      await mailService.send({
        to: data.user.email,
        subject: "Reset your SourceWeft password",
        html: renderLinkTemplate({
          title: "Reset your password",
          message:
            "We received a request to reset your password. Use the button below to continue.",
          buttonLabel: "Reset password",
          buttonUrl: data.url,
        }),
        templateId: "auth.reset-password",
        messageType: "auth.reset-password",
      });
    },
  },
  emailVerification: {
    sendOnSignUp: false,
    async sendVerificationEmail(data) {
      await mailService.send({
        to: data.user.email,
        subject: "Verify your SourceWeft email",
        html: renderLinkTemplate({
          title: "Verify your email",
          message:
            "Confirm your email address to complete account setup and secure your access.",
          buttonLabel: "Verify email",
          buttonUrl: data.url,
        }),
        templateId: "auth.verify-email",
        messageType: "auth.verify-email",
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
        await mailService.send({
          to: data.email,
          subject: `${data.inviter.user.name || data.inviter.user.email} invited you to ${data.organization.name}`,
          html: renderLinkTemplate({
            title: `Join ${data.organization.name}`,
            message:
              "You were invited to join an organization on SourceWeft. Sign in and accept the invitation.",
            buttonLabel: "Accept invitation",
            buttonUrl: withBaseUrl(
              `/auth/accept-invitation?invitationId=${encodeURIComponent(data.id)}`,
            ),
          }),
          templateId: "org.invitation",
          messageType: "org.invitation",
        });
      },
      organizationHooks: {
        async afterCreateOrganization({ organization, user }) {
          await onboardingService.provisionOrganization({
            organizationId: organization.id,
            userId: user.id,
          });
        },
      },
    }),
    twoFactor({
      issuer: "SourceWeft",
      otpOptions: {
        async sendOTP({ user, otp }) {
          await mailService.send({
            to: user.email,
            subject: "Your two-factor verification code",
            html: renderOtpTemplate({
              title: "Two-factor verification",
              message:
                "Use this verification code to complete your SourceWeft sign-in.",
              otp,
            }),
            templateId: "auth.two-factor-otp",
            messageType: "auth.two-factor-otp",
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
            persistSubscriptions: false,
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
                "subscription.updated",
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
        const labels: Record<string, { title: string; message: string }> = {
          "sign-in": {
            title: "Your sign-in code",
            message: "Use this code to sign in to SourceWeft.",
          },
          "email-verification": {
            title: "Verify your email",
            message:
              "Use this verification code to confirm your email address.",
          },
          "forget-password": {
            title: "Reset your password",
            message: "Use this code to continue resetting your password.",
          },
        };

        const content = labels[type] || {
          title: "Your sign-in code",
          message: "Use this code to sign in to SourceWeft.",
        };

        await mailService.send({
          to: email,
          subject: content.title,
          html: renderOtpTemplate({
            title: content.title,
            message: content.message,
            otp,
          }),
          templateId: `auth.email-otp.${type}`,
          messageType: "auth.email-otp",
        });
      },
    }),
    magicLink({
      async sendMagicLink({ email, url }) {
        await mailService.send({
          to: email,
          subject: "Your SourceWeft magic link",
          html: renderLinkTemplate({
            title: "Sign in with magic link",
            message: "Use this secure link to continue signing in.",
            buttonLabel: "Sign in",
            buttonUrl: url,
          }),
          templateId: "auth.magic-link",
          messageType: "auth.magic-link",
        });
      },
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
            createOrganization: auth.api.createOrganization,
          });
        },
      },
    },
  },
});

export async function getSession(headers: Headers) {
  return auth.api.getSession({ headers });
}
