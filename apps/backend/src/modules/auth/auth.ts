import { betterAuth } from "better-auth";
import { createHash } from "node:crypto";
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
import type { BillingSubscriptionStatus } from "@sourceweft/contracts";
import { config } from "../../shared/config";
import { database } from "../../shared/database";
import { logger } from "../../shared/logger";
import { billingService } from "../billing";
import { mailService } from "../../shared/mail";
import { opsAlertService } from "../ops";
import { workspaceService } from "../workspace";
import { renderLinkTemplate, renderOtpTemplate } from "./templates";
import type { TeamSubscriptionSnapshot } from "../billing";

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

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function pickString(value: unknown, keys: string[]) {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }

  return null;
}

function pickBoolean(value: unknown, keys: string[]) {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "boolean") {
      return candidate;
    }
  }

  return null;
}

function pickDateIso(value: unknown, keys: string[]) {
  const text = pickString(value, keys);
  if (!text) {
    return null;
  }

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString();
}

function stableSerialize(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }

  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const entries = keys.map(
      (key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`,
    );

    return `{${entries.join(",")}}`;
  }

  return JSON.stringify(String(value));
}

function createFallbackWebhookEventId(input: {
  eventType: string;
  teamId: string | null;
  externalSubscriptionId: string | null;
  externalCustomerId: string | null;
  externalProductId: string | null;
  subscriptionStatus: BillingSubscriptionStatus | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  fallbackStatus: BillingSubscriptionStatus;
}) {
  const seed = {
    provider: "creem",
    eventType: input.eventType,
    teamId: input.teamId,
    externalSubscriptionId: input.externalSubscriptionId,
    externalCustomerId: input.externalCustomerId,
    externalProductId: input.externalProductId,
    subscriptionStatus: input.subscriptionStatus,
    currentPeriodStart: input.currentPeriodStart,
    currentPeriodEnd: input.currentPeriodEnd,
    cancelAtPeriodEnd: input.cancelAtPeriodEnd,
    fallbackStatus: input.fallbackStatus,
  };

  const digest = createHash("sha256")
    .update(stableSerialize(seed))
    .digest("hex")
    .slice(0, 32);

  return `fallback:${digest}`;
}

function resolveTeamId(
  metadata: Record<string, unknown> | null,
  data: unknown,
) {
  const fromMetadata = metadata?.teamId;
  if (typeof fromMetadata === "string" && fromMetadata.trim()) {
    return fromMetadata;
  }

  return pickString(data, ["teamId"]);
}

function resolvePlanFamily(
  metadata: Record<string, unknown> | null,
  data: unknown,
): "team_standard" | null {
  if (metadata?.planFamily === "team_standard") {
    return "team_standard";
  }

  const product = asRecord(asRecord(data)?.product ?? null);
  const productId =
    pickString(data, ["productId", "creemProductId", "product_id"]) ||
    pickString(product, ["id", "productId"]);

  if (productId && productId === config.billing.creem.teamStandardProductId) {
    return "team_standard";
  }

  return null;
}

function normalizeSubscriptionStatus(
  value: string | null,
  fallback: BillingSubscriptionStatus,
): BillingSubscriptionStatus {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  const allowed = new Set<BillingSubscriptionStatus>([
    "inactive",
    "trialing",
    "active",
    "past_due",
    "paused",
    "unpaid",
    "canceled",
    "expired",
  ]);

  if (allowed.has(normalized as BillingSubscriptionStatus)) {
    return normalized as BillingSubscriptionStatus;
  }

  if (normalized === "paid") {
    return "active";
  }

  return fallback;
}

function buildCreemSubscriptionSnapshot(
  data: unknown,
  fallbackStatus: BillingSubscriptionStatus,
): TeamSubscriptionSnapshot | null {
  const metadata = asRecord(asRecord(data)?.metadata ?? null);
  const teamId = resolveTeamId(metadata, data);
  const planFamily = resolvePlanFamily(metadata, data);

  if (!teamId || !planFamily) {
    return null;
  }

  const customer = asRecord(asRecord(data)?.customer ?? null);
  const product = asRecord(asRecord(data)?.product ?? null);

  const externalCustomerId =
    pickString(data, ["creemCustomerId", "customerId", "customer_id"]) ||
    pickString(customer, ["id", "customerId"]) ||
    null;

  const externalSubscriptionId =
    pickString(data, [
      "creemSubscriptionId",
      "subscriptionId",
      "subscription_id",
    ]) || null;

  const externalProductId =
    pickString(data, ["productId", "creemProductId", "product_id"]) ||
    pickString(product, ["id", "productId"]) ||
    null;

  const status = normalizeSubscriptionStatus(
    pickString(data, ["status", "subscriptionStatus", "subscription_status"]),
    fallbackStatus,
  );

  return {
    teamId,
    provider: "creem",
    planFamily,
    status,
    currentPeriodStart: pickDateIso(data, [
      "currentPeriodStart",
      "current_period_start",
      "periodStart",
      "current_period_start_date",
    ]),
    currentPeriodEnd: pickDateIso(data, [
      "currentPeriodEnd",
      "current_period_end",
      "periodEnd",
      "current_period_end_date",
      "next_billing_date",
    ]),
    externalCustomerId,
    externalSubscriptionId,
    externalProductId,
    cancelAtPeriodEnd:
      pickBoolean(data, ["cancelAtPeriodEnd", "cancel_at_period_end"]) ?? false,
    metadata: metadata ?? {},
    seatCount: resolveCreemSeatCount(data, metadata),
  };
}

function resolveCreemSeatCount(
  data: unknown,
  metadata: Record<string, unknown> | null,
): number {
  // 1. Try items[0].units from Creem subscription webhook payload
  const record = asRecord(data);
  const items = record?.items;
  if (Array.isArray(items) && items.length > 0) {
    const firstItem = asRecord(items[0]);
    const units = firstItem?.units;
    if (typeof units === "number" && Number.isFinite(units) && units >= 2) {
      return Math.floor(units);
    }
  }

  // 2. Fallback: seatCount stored in checkout metadata
  const metaSeatCount = metadata?.seatCount;
  if (
    typeof metaSeatCount === "number" &&
    Number.isFinite(metaSeatCount) &&
    metaSeatCount >= 2
  ) {
    return Math.floor(metaSeatCount);
  }

  // 3. Default to 2 (minimum for team plan)
  return 2;
}

async function syncCreemSubscriptionEvent(
  eventType: string,
  data: unknown,
  fallbackStatus: BillingSubscriptionStatus,
) {
  const payload = asRecord(data) ?? {
    raw: data,
  };
  const snapshot = buildCreemSubscriptionSnapshot(data, fallbackStatus);

  const rawProviderEventId = pickString(data, [
    "eventId",
    "event_id",
    "webhookId",
    "webhook_id",
    "requestId",
    "request_id",
  ]);

  const externalSubscriptionId =
    snapshot?.externalSubscriptionId ||
    pickString(data, [
      "creemSubscriptionId",
      "subscriptionId",
      "subscription_id",
    ]);

  const teamId =
    snapshot?.teamId || resolveTeamId(asRecord(payload.metadata), data);

  const providerEventId =
    rawProviderEventId ||
    createFallbackWebhookEventId({
      eventType,
      teamId: teamId ?? null,
      externalSubscriptionId: externalSubscriptionId ?? null,
      externalCustomerId: snapshot?.externalCustomerId ?? null,
      externalProductId: snapshot?.externalProductId ?? null,
      subscriptionStatus: snapshot?.status ?? fallbackStatus,
      currentPeriodStart: snapshot?.currentPeriodStart ?? null,
      currentPeriodEnd: snapshot?.currentPeriodEnd ?? null,
      cancelAtPeriodEnd: snapshot?.cancelAtPeriodEnd ?? false,
      fallbackStatus,
    });

  async function triggerAlertSafely(
    input: Parameters<typeof opsAlertService.trigger>[0],
  ) {
    try {
      await opsAlertService.trigger(input);
    } catch (alertError) {
      logger.error("Failed to emit ops alert for billing webhook", {
        eventType,
        alertKey: input.alertKey,
        error:
          alertError instanceof Error ? alertError.message : String(alertError),
      });
    }
  }

  try {
    if (!rawProviderEventId) {
      await triggerAlertSafely({
        alertKey: `billing:webhook:missing-event-id:${eventType}:${teamId || "unknown"}`,
        level: "warn",
        source: "billing.webhook",
        title: "Subscription webhook missing provider event id",
        message:
          "Provider webhook did not include an event id; fallback dedupe key was generated",
        teamId: teamId ?? null,
        metadata: {
          eventType,
          generatedProviderEventId: providerEventId,
          fallbackStatus,
        },
      });
    }

    const result = await billingService.processSubscriptionWebhookEvent({
      provider: "creem",
      providerEventId,
      eventType,
      payload,
      teamId: teamId ?? null,
      externalSubscriptionId: externalSubscriptionId ?? null,
      metadata: {
        fallbackStatus,
      },
      snapshot,
    });

    if (result.outcome === "ignored") {
      const ignoreReason = result.reason || "unknown";
      const ignoreMessages: Record<string, string> = {
        context_missing:
          "Webhook ignored due to missing team/plan mapping in provider payload",
        team_billing_disabled:
          "Webhook recorded but business sync skipped because team billing is disabled",
      };

      await triggerAlertSafely({
        alertKey: `billing:webhook:ignored:${eventType}:${teamId || "unknown"}`,
        level: "warn",
        source: "billing.webhook",
        title: "Subscription webhook ignored",
        message:
          ignoreMessages[ignoreReason] ||
          `Webhook ignored for event ${eventType} (${ignoreReason})`,
        teamId: teamId ?? null,
        metadata: {
          fallbackStatus,
          providerEventId,
          reason: ignoreReason,
        },
      });
      return;
    }

    if (result.outcome === "duplicate") {
      logger.info("Ignored duplicate creem webhook event", {
        eventType,
        providerEventId,
        teamId: teamId ?? null,
      });
      return;
    }

    await opsAlertService
      .resolve(`billing:webhook:failed:${eventType}:${teamId || "unknown"}`)
      .catch(() => null);
    await opsAlertService
      .resolve(`billing:webhook:ignored:${eventType}:${teamId || "unknown"}`)
      .catch(() => null);
  } catch (error) {
    await triggerAlertSafely({
      alertKey: `billing:webhook:failed:${eventType}:${teamId || "unknown"}`,
      level: "error",
      source: "billing.webhook",
      title: "Subscription webhook processing failed",
      message:
        error instanceof Error
          ? error.message
          : "Unknown webhook processing error",
      teamId: teamId ?? null,
      metadata: {
        eventType,
        providerEventId,
        fallbackStatus,
        externalSubscriptionId,
      },
    });

    logger.error("Failed to sync creem subscription event", {
      eventType,
      providerEventId,
      teamId: teamId ?? null,
      status: snapshot?.status,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export const auth: any = betterAuth({
  appName: "SourceWeft",
  baseURL: config.auth.baseUrl,
  secret: config.auth.secret,
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
      enabled: true,
      async sendChangeEmailConfirmation(data) {
        await mailService.send({
          to: data.user.email,
          subject: "Confirm your email change",
          html: renderLinkTemplate({
            title: "Confirm email change",
            message: `A request was made to change your account email to ${data.newEmail}. Approve this change to continue.`,
            buttonLabel: "Approve email change",
            buttonUrl: data.url,
          }),
          templateId: "auth.change-email",
          messageType: "auth.change-email",
        });
      },
    },
    deleteUser: {
      enabled: true,
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
          await workspaceService.ensureDefaultWorkspace({
            organizationId: organization.id,
            userId: user.id,
          });
          await billingService.ensureBillingAccount(organization.id);
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
});

export async function getSession(headers: Headers) {
  return auth.api.getSession({ headers });
}
