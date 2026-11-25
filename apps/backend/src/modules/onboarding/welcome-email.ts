import type { Locale } from "@sourceweft/i18n";
import { getBillingDeploymentCapabilities } from "../../billing-host/bindings";
import { logger } from "../../shared/logger";
import { config } from "../../shared/config";
import { enqueueWithAudit } from "../../shared/queue";
import { resolveMailLocale } from "../auth/mail-locale";
import { mailDeliveryConfigured } from "../mail/delivery";

export const WELCOME_EMAIL_JOB = "welcome-email";
export const WELCOME_EMAIL_JOB_ATTEMPTS = 5;
export const WELCOME_EMAIL_JOB_BACKOFF_MS = 60_000;

const WELCOME_EMAIL_COMMUNITY_URL = "https://discord.gg/KNqTGh2qrk";
const WELCOME_EMAIL_GITHUB_URL = "https://github.com/sourceweft/sourceweft";

const WELCOME_EMAIL_NAME_MAX_LENGTH = 80;

export type WelcomeEmailJobPayload = { userId: string; locale: string };

export type WelcomeMailVariables = {
  name: string | null;
  freeCredits: string | null;
  freePages: string | null;
  baseUrl: string;
  imageUrl: string;
  dashboardUrl: string;
  chatUrl: string;
  scheduledUrl: string;
  assistantUrl: string;
  downloadUrl: string;
  communityUrl: string;
  githubUrl: string;
};

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizeName(name: string | null | undefined): string | null {
  const trimmed = name?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.slice(0, WELCOME_EMAIL_NAME_MAX_LENGTH);
}

function resolveFreeAllowance(locale: Locale): {
  freeCredits: string | null;
  freePages: string | null;
} {
  const capabilities = getBillingDeploymentCapabilities();
  if (!capabilities.billing.available) {
    return { freeCredits: null, freePages: null };
  }

  const free = capabilities.billing.catalog.plans.free;
  if (free.credits === 0 || free.pages === 0) {
    return { freeCredits: null, freePages: null };
  }

  const formatter = new Intl.NumberFormat(locale);
  return {
    freeCredits: formatter.format(free.credits),
    freePages: formatter.format(free.pages),
  };
}

export function welcomeEmailJobId(userId: string): string {
  return `${WELCOME_EMAIL_JOB}_${userId}`;
}

export function buildWelcomeMailVariables(input: {
  name: string | null | undefined;
  locale: Locale;
}): WelcomeMailVariables {
  const baseUrl = stripTrailingSlash(config.auth.webBaseUrl);
  const { freeCredits, freePages } = resolveFreeAllowance(input.locale);

  return {
    name: normalizeName(input.name),
    freeCredits,
    freePages,
    baseUrl,
    imageUrl: `${baseUrl}/icon-512.png`,
    dashboardUrl: `${baseUrl}/dashboard`,
    chatUrl: `${baseUrl}/dashboard/chat`,
    scheduledUrl: `${baseUrl}/dashboard/scheduled`,
    assistantUrl: `${baseUrl}/dashboard/assistant`,
    downloadUrl:
      input.locale === "en"
        ? `${baseUrl}/download`
        : `${baseUrl}/${input.locale}/download`,
    communityUrl: WELCOME_EMAIL_COMMUNITY_URL,
    githubUrl: WELCOME_EMAIL_GITHUB_URL,
  };
}

export async function enqueueWelcomeEmail(input: {
  userId: string;
  headers?: Headers | null;
}): Promise<void> {
  try {
    if (!mailDeliveryConfigured()) {
      return;
    }

    const locale = await resolveMailLocale({
      userId: input.userId,
      headers: input.headers,
    });

    const payload: WelcomeEmailJobPayload = {
      userId: input.userId,
      locale,
    };

    await enqueueWithAudit(WELCOME_EMAIL_JOB, payload, {
      jobId: welcomeEmailJobId(input.userId),
      attempts: WELCOME_EMAIL_JOB_ATTEMPTS,
      backoff: { type: "exponential", delay: WELCOME_EMAIL_JOB_BACKOFF_MS },
      removeOnComplete: 100,
      removeOnFail: 100,
    });
  } catch (error) {
    logger.error("welcome_email_enqueue_failed", {
      userId: input.userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
