import type { Locale } from "@sourceweft/i18n";

const WELCOME_EMAIL_COMMUNITY_URL = "https://discord.gg/KNqTGh2qrk";
const WELCOME_EMAIL_GITHUB_URL = "https://github.com/sourceweft/sourceweft";

const WELCOME_EMAIL_NAME_MAX_LENGTH = 80;

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

function formatFreeAllowance(
  locale: Locale,
  freeAllowance: { credits: number; pages: number } | null,
): { freeCredits: string | null; freePages: string | null } {
  if (
    !freeAllowance ||
    freeAllowance.credits === 0 ||
    freeAllowance.pages === 0
  ) {
    return { freeCredits: null, freePages: null };
  }

  const formatter = new Intl.NumberFormat(locale);
  return {
    freeCredits: formatter.format(freeAllowance.credits),
    freePages: formatter.format(freeAllowance.pages),
  };
}

/**
 * Builds the welcome email's template variables from already-resolved inputs.
 * Pure and config-free: it never reads `shared/config`, the billing bindings,
 * the queue, the logger, the mail module or the database, so it can be
 * imported by scripts that run without a backend `.env`.
 */
export function composeWelcomeMailVariables(input: {
  name: string | null | undefined;
  locale: Locale;
  webBaseUrl: string;
  freeAllowance: { credits: number; pages: number } | null;
}): WelcomeMailVariables {
  const baseUrl = stripTrailingSlash(input.webBaseUrl);
  const { freeCredits, freePages } = formatFreeAllowance(
    input.locale,
    input.freeAllowance,
  );

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
