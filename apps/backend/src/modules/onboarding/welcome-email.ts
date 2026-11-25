import { DEFAULT_LOCALE, isLocale, type Locale } from "@sourceweft/i18n";
import { database } from "@sourceweft/db";
import { getBillingDeploymentCapabilities } from "../../billing-host/bindings";
import { logger } from "../../shared/logger";
import { config } from "../../shared/config";
import { enqueueWithAudit } from "../../shared/queue";
import { resolveMailLocale } from "../auth/mail-locale";
import { mailDeliveryConfigured } from "../mail/delivery";
import { mailService } from "../mail";
import {
  composeWelcomeMailVariables,
  type WelcomeMailVariables,
} from "./welcome-mail-variables";

export const WELCOME_EMAIL_JOB = "welcome-email";
export const WELCOME_EMAIL_JOB_ATTEMPTS = 5;
export const WELCOME_EMAIL_JOB_BACKOFF_MS = 60_000;

export type { WelcomeMailVariables };

export type WelcomeEmailJobPayload = { userId: string; locale: string };

function resolveFreeAllowance(): { credits: number; pages: number } | null {
  const capabilities = getBillingDeploymentCapabilities();
  if (!capabilities.billing.available) {
    return null;
  }

  return capabilities.billing.catalog.plans.free;
}

export function welcomeEmailJobId(userId: string): string {
  return `${WELCOME_EMAIL_JOB}_${userId}`;
}

export function buildWelcomeMailVariables(input: {
  name: string | null | undefined;
  locale: Locale;
}): WelcomeMailVariables {
  return composeWelcomeMailVariables({
    name: input.name,
    locale: input.locale,
    webBaseUrl: config.auth.webBaseUrl,
    freeAllowance: resolveFreeAllowance(),
  });
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

type WelcomeEmailUserRow = {
  email: string | null;
  name: string | null;
  emailVerified: boolean | null;
};

/**
 * Sends the welcome email for a job's payload. Runs from the worker (and from
 * its tests) on a plain, untyped payload, so every field is checked before
 * use: a missing/non-string `userId` and an unconfigured mail provider both
 * throw so the job fails loudly instead of silently doing nothing. A user
 * that no longer exists, or whose email is missing or unverified, is a normal
 * skip, not an error — logged without the email address or name. A provider
 * failure from `sendTemplate` is left to propagate so BullMQ retries the job.
 */
export async function sendWelcomeEmail(
  payload: Record<string, unknown>,
): Promise<"sent" | "skipped"> {
  const userId = payload.userId;
  if (typeof userId !== "string" || userId.length === 0) {
    throw new Error("sendWelcomeEmail requires a string userId");
  }

  if (!mailDeliveryConfigured()) {
    throw new Error("Mail delivery is not configured for this deployment");
  }

  const result = await database.query<WelcomeEmailUserRow>(
    'select email, name, "emailVerified" from "user" where id = $1',
    [userId],
  );
  const row = result.rows[0];

  if (!row || !row.email) {
    logger.info("welcome_email_skipped", { userId, reason: "user_missing" });
    return "skipped";
  }

  if (!row.emailVerified) {
    logger.info("welcome_email_skipped", {
      userId,
      reason: "email_unverified",
    });
    return "skipped";
  }

  const locale: Locale = isLocale(payload.locale)
    ? payload.locale
    : DEFAULT_LOCALE;

  await mailService.sendTemplate({
    to: row.email,
    templateId: "auth.welcome",
    messageType: "auth.welcome",
    locale,
    variables: buildWelcomeMailVariables({ name: row.name, locale }),
  });

  return "sent";
}
