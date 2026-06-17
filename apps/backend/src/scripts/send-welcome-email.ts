import "dotenv/config";

import { renderMailTemplate } from "../modules/mail/templates";

type Args = {
  dryRun: boolean;
  email: string | null;
  name: string | null;
};

const USAGE = [
  "Usage: pnpm --filter @sourceweft/backend run mail:welcome -- --email user@example.com [--name Alice] [--dry-run]",
  "",
  "Options:",
  "  --email <email>   Recipient email address.",
  "  --name <name>     Optional recipient display name.",
  "  --dry-run         Print the email payload without sending it.",
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
  return {
    dryRun: argv.includes("--dry-run"),
    email: readOption(argv, "email"),
    name: readOption(argv, "name"),
  };
}

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function resolveWebBaseUrl() {
  return (
    process.env.NEXT_PUBLIC_WEB_BASE_URL?.trim() || "http://localhost:3000"
  ).replace(/\/$/, "");
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

  const webBaseUrl = resolveWebBaseUrl();
  const dashboardUrl = `${webBaseUrl}/dashboard`;
  const name = args.name?.trim() || null;
  const rendered = renderMailTemplate("auth.welcome", {
    baseUrl: webBaseUrl,
    dashboardUrl,
    discordUrl: "https://discord.gg/KNqTGh2qrk",
    docsUrl: `${webBaseUrl}/docs`,
    greeting: name ? `Hi ${name},` : "Hi there,",
    githubUrl: "https://github.com/sourceweft/sourceweft",
    imageUrl: `${webBaseUrl}/icon-512.png`,
    name,
  });

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
      dashboardUrl,
      name,
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
