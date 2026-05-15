import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

type Args = {
  productIds: string[];
  yes: boolean;
};

type DeleteResult = {
  productId: string;
  ok: boolean;
  status: number;
  endpoint: string;
  response: unknown;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, "../..");

const USAGE = [
  "Usage: pnpm --filter @sourceweft/backend run creem:product:delete -- prod_xxx [prod_yyy] --yes",
  "",
  "Examples:",
  "  pnpm --filter @sourceweft/backend run creem:product:delete -- prod_abc --yes",
  "  pnpm --filter @sourceweft/backend run creem:product:delete -- --product-id prod_abc --yes",
  "  pnpm --filter @sourceweft/backend run creem:product:delete -- --product-ids prod_abc,prod_def --yes",
  "",
  "Environment:",
  "  CREEM_API_KEY is required.",
  "  CREEM_TEST_MODE controls test vs live Creem API mode and defaults to true.",
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

function readPositionals(argv: string[]) {
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg || arg === "--") {
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

function parseProductIds(raw: Array<string | null>) {
  return raw
    .flatMap((value) => value?.split(",") ?? [])
    .map((value) => value.trim())
    .filter(Boolean);
}

function parseArgs(argv: string[]): Args | null {
  const productIds = [
    ...parseProductIds([
      readOption(argv, "product-id"),
      readOption(argv, "product-ids"),
    ]),
    ...readPositionals(argv),
  ];

  if (productIds.length === 0) {
    return null;
  }

  return {
    productIds: Array.from(new Set(productIds)),
    yes: argv.includes("--yes") || argv.includes("-y"),
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
  for (const file of [
    path.join(BACKEND_ROOT, ".env"),
    path.join(BACKEND_ROOT, ".env.local"),
  ]) {
    loadDotenv({ path: file, override: false, quiet: true });
  }
}

function getApiBase(testMode: boolean) {
  return testMode ? "https://test-api.creem.io" : "https://api.creem.io";
}

async function readResponseBody(response: Response) {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function deleteProduct(input: {
  apiBase: string;
  apiKey: string;
  productId: string;
}): Promise<DeleteResult> {
  const endpoint = `${input.apiBase}/v1/products/${encodeURIComponent(
    input.productId,
  )}/delete`;
  const response = await fetch(endpoint, {
    method: "DELETE",
    headers: {
      "x-api-key": input.apiKey,
    },
  });
  const body = await readResponseBody(response);

  return {
    productId: input.productId,
    ok: response.ok,
    status: response.status,
    endpoint,
    response: body,
  };
}

async function main() {
  loadEnvFiles();

  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    throw new Error(`Missing product id.\n\n${USAGE}`);
  }

  if (!args.yes) {
    throw new Error(
      `Refusing to delete Creem products without --yes.\n\nProducts:\n${args.productIds
        .map((productId) => `  - ${productId}`)
        .join("\n")}\n\n${USAGE}`,
    );
  }

  const apiKey = process.env.CREEM_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(`CREEM_API_KEY is required.\n\n${USAGE}`);
  }

  const testMode = parseBoolean(process.env.CREEM_TEST_MODE, true);
  const apiBase = getApiBase(testMode);
  const results: DeleteResult[] = [];

  for (const productId of args.productIds) {
    results.push(await deleteProduct({ apiBase, apiKey, productId }));
  }

  const failed = results.filter((result) => !result.ok);
  console.log(
    JSON.stringify(
      results.length === 1 ? results[0] : { products: results },
      null,
      2,
    ),
  );

  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
