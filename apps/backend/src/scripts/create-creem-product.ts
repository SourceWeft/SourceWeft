import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { createCreemClient } from "@creem_io/better-auth/server";
import {
  getPricingConfig,
  type PlanConfig,
} from "@sourceweft/contracts/pricing";

type BillingInterval = "monthly" | "yearly";
type PaidPlanId = Extract<PlanConfig["id"], "pro" | "team">;
type Args = {
  plan: PaidPlanId;
  intervals: BillingInterval[];
};

type ProductPayload = {
  envVar: string;
  name: string;
  description: string;
  price: number;
  billingPeriod: "every-month" | "every-year";
};

type CreatedProduct = {
  productId: string;
  envVar: string;
  plan: PaidPlanId;
  interval: BillingInterval;
  name: string;
  price: number;
  currency: "USD";
  billingType: "recurring";
  billingPeriod: "every-month" | "every-year";
  taxMode: "exclusive";
  taxCategory: "saas";
  description: string;
  productUrl: string | null;
  mode: unknown;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, "../..");
const REPO_ROOT = path.resolve(BACKEND_ROOT, "../..");

const USAGE = [
  "Usage: pnpm --filter @sourceweft/backend run creem:product:create -- pro|team [monthly|yearly]",
  "",
  "Examples:",
  "  pnpm --filter @sourceweft/backend run creem:product:create -- pro",
  "  pnpm --filter @sourceweft/backend run creem:product:create -- team",
  "  pnpm --filter @sourceweft/backend run creem:product:create -- pro monthly",
  "  pnpm --filter @sourceweft/backend run creem:product:create -- team-yearly",
  "",
  "Compatibility:",
  "  --plan pro and --plan pro --interval monthly still work.",
  "",
  "Environment:",
  "  CREEM_API_KEY is required.",
  "  CREEM_TEST_MODE controls test vs live Creem API mode and defaults to true.",
  "  NEXT_PUBLIC_PRICING_* values are loaded from apps/web env files for pricing.",
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

function parsePlan(value: string | null): PaidPlanId | null {
  return value === "pro" || value === "team" ? value : null;
}

function parseInterval(value: string | null): BillingInterval | null {
  return value === "monthly" || value === "yearly" ? value : null;
}

function readPositionals(argv: string[]) {
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) {
      continue;
    }

    if (arg === "--") {
      continue;
    }

    if (arg.startsWith("--")) {
      const hasInlineValue = arg.includes("=");
      const next = argv[i + 1];
      if (!hasInlineValue && next && !next.startsWith("--")) {
        i += 1;
      }
      continue;
    }

    positionals.push(arg.trim());
  }

  return positionals.filter(Boolean);
}

function parseCombined(value: string | null) {
  if (!value) {
    return null;
  }

  const [plan, interval] = value.split("-");
  const parsedPlan = parsePlan(plan ?? null);
  const parsedInterval = parseInterval(interval ?? null);

  if (!parsedPlan || !parsedInterval) {
    return null;
  }

  return { plan: parsedPlan, interval: parsedInterval };
}

function parseArgs(argv: string[]): Args | null {
  const positionals = readPositionals(argv);
  const planOption = parsePlan(readOption(argv, "plan"));
  const intervalOption = parseInterval(readOption(argv, "interval"));
  const combined =
    parseCombined(readOption(argv, "product")) ?? parseCombined(positionals[0] ?? null);
  const plan = planOption ?? combined?.plan ?? parsePlan(positionals[0] ?? null);
  const interval =
    intervalOption ?? combined?.interval ?? parseInterval(positionals[1] ?? null);

  if (!plan) {
    return null;
  }

  return {
    plan,
    intervals: interval ? [interval] : ["monthly", "yearly"],
  };
}

function parseBoolean(value: string | undefined, fallback: boolean) {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return true;
  }

  if (normalized === "false" || normalized === "0") {
    return false;
  }

  return fallback;
}

function loadEnvFiles() {
  const files = [
    path.join(BACKEND_ROOT, ".env"),
    path.join(BACKEND_ROOT, ".env.local"),
    path.join(REPO_ROOT, "apps/web/.env"),
    path.join(REPO_ROOT, "apps/web/.env.local"),
  ];

  for (const file of files) {
    loadDotenv({ path: file, override: false, quiet: true });
  }
}

function resolvePlan(planId: PaidPlanId): PlanConfig & { id: PaidPlanId } {
  const plan = getPricingConfig().find((entry) => entry.id === planId);
  if (!plan) {
    throw new Error(`Pricing config is missing plan: ${planId}`);
  }

  return plan as PlanConfig & { id: PaidPlanId };
}

function resolveEnvVar(plan: PaidPlanId, interval: BillingInterval) {
  if (plan === "pro") {
    return interval === "monthly"
      ? "CREEM_INDIVIDUAL_PRO_MONTHLY_PRODUCT_ID"
      : "CREEM_INDIVIDUAL_PRO_YEARLY_PRODUCT_ID";
  }

  return interval === "monthly"
    ? "CREEM_TEAM_STANDARD_MONTHLY_PRODUCT_ID"
    : "CREEM_TEAM_STANDARD_YEARLY_PRODUCT_ID";
}

function formatInterval(interval: BillingInterval) {
  return interval === "monthly" ? "Monthly" : "Yearly";
}

function buildDescription(plan: PlanConfig, interval: BillingInterval) {
  const lines = [
    plan.description,
    "",
    `Billing: ${formatInterval(interval)}`,
  ];

  if (plan.id === "team") {
    lines.push("Pricing: per seat. Checkout units represent seats.");
  }

  lines.push("", "Includes:", ...plan.features.map((feature) => `- ${feature}`));

  return lines.join("\n");
}

function buildProductPayload(
  plan: PlanConfig & { id: PaidPlanId },
  interval: BillingInterval,
): ProductPayload {
  const price = interval === "monthly" ? plan.monthlyPrice : plan.yearlyPrice;
  if (!Number.isInteger(price) || price < 100) {
    throw new Error(
      `Invalid ${plan.id} ${interval} price from pricing config: ${price}`,
    );
  }

  return {
    envVar: resolveEnvVar(plan.id, interval),
    name: `SourceWeft ${plan.name} ${formatInterval(interval)}`,
    description: buildDescription(plan, interval),
    price,
    billingPeriod: interval === "monthly" ? "every-month" : "every-year",
  };
}

async function main() {
  loadEnvFiles();

  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    throw new Error(`Missing or invalid product.\n\n${USAGE}`);
  }

  const apiKey = process.env.CREEM_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(`CREEM_API_KEY is required.\n\n${USAGE}`);
  }

  const testMode = parseBoolean(process.env.CREEM_TEST_MODE, true);
  const plan = resolvePlan(args.plan);
  const creem = createCreemClient({ apiKey, testMode });
  const products: CreatedProduct[] = [];

  for (const interval of args.intervals) {
    const payload = buildProductPayload(plan, interval);
    const product = await creem.products.create({
      name: payload.name,
      description: payload.description,
      price: payload.price,
      currency: "USD",
      billingType: "recurring",
      billingPeriod: payload.billingPeriod,
      taxMode: "exclusive",
      taxCategory: "saas",
    });

    products.push({
      productId: product.id,
      envVar: payload.envVar,
      plan: args.plan,
      interval,
      name: payload.name,
      price: payload.price,
      currency: "USD",
      billingType: "recurring",
      billingPeriod: payload.billingPeriod,
      taxMode: "exclusive",
      taxCategory: "saas",
      description: payload.description,
      productUrl: product.productUrl ?? null,
      mode: product.mode ?? (testMode ? "test" : "live"),
    });
  }

  console.log(
    JSON.stringify(
      products.length === 1 ? products[0] : { products },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
