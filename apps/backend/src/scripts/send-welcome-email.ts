import "dotenv/config";

import { isLocale, type Locale } from "@sourceweft/i18n";
import { renderMailTemplate } from "../modules/mail/templates";

type Args = {
  dryRun: boolean;
  email: string | null;
  name: string | null;
  locale: Locale;
};

const USAGE = [
  "Usage: pnpm --filter @sourceweft/backend run mail:welcome -- --email user@example.com [--name Alice] [--locale en|zh-CN|zh-TW] [--dry-run]",
  "",
  "This script loads the backend configuration (the same environment as the API) to build the links and free allowance, including for --dry-run.",
  "",
  "Options:",
  "  --email <email>    Recipient email address.",
  "  --name <name>      Optional recipient display name.",
  "  --locale <locale>  Email locale: en (default), zh-CN, or zh-TW.",
  "  --dry-run          Print the email payload without sending it.",
].join("\n");

function readOption(argv: string[], name: string) {
  const prefix = `--${name}=`;
  const inline = argv.find((arg) => arg.startsWith(prefix));
  if (inline) {
    return inline.slice(prefix.length).trim();
  }

  const index = argv.indexOf(`--${name}`);
  if (index >= 0) {
    const value = argv[index + 1];
    if (value && !value.startsWith("--")) {
      return value.trim();
    }
  }

  return null;
}

function parseArgs(argv: string[]): Args {
  const localeOption = readOption(argv, "locale");
  const locale = localeOption === null ? "en" : localeOption;
  if (!isLocale(locale)) {
    throw new Error(`Invalid --locale value: ${locale}\n\n${USAGE}`);
  }

  return {
    dryRun: argv.includes("--dry-run"),
    email: readOption(argv, "email"),
    name: readOption(argv, "name"),
    locale,
  };
}

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.email) {
    throw new Error(`Missing --email.\n\n${USAGE}`);
  }

  if (!isValidEmail(args.email)) {
    throw new Error(`Invalid --email value: ${args.email}`);
  }

  const mailProvider = process.env.MAIL_PROVIDER || "console";
  if (!args.dryRun && mailProvider.toLowerCase() === "plunk") {
    if (!process.env.PLUNK_API_KEY?.trim()) {
      throw new Error("PLUNK_API_KEY is required to send welcome email.");
    }
  }

  const { buildWelcomeMailVariables } =
    await import("../modules/onboarding/welcome-email");
  const variables = buildWelcomeMailVariables({
    name: args.name,
    locale: args.locale,
  });
  const rendered = renderMailTemplate("auth.welcome", variables, args.locale);

  if (args.dryRun) {
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          to: args.email,
          subject: rendered.subject,
          templateId: "auth.welcome.test",
          messageType: "auth.welcome",
          text: rendered.text,
          htmlPreview: rendered.html.slice(0, 500),
          locale: args.locale,
        },
        null,
        2,
      ),
    );
    return;
  }

  const { mailService } = await import("../modules/mail");
  const result = await mailService.send({
    to: args.email,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    templateId: "auth.welcome.test",
    messageType: "auth.welcome",
    variables: {
      dashboardUrl: variables.dashboardUrl,
      name: variables.name,
      test: true,
    },
  });

  console.log(
    JSON.stringify(
      {
        accepted: result.accepted,
        provider: result.provider,
        requestId: result.requestId ?? null,
        messageIds: result.messageIds,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
