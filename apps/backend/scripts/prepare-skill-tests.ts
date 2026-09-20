import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { parse } from "dotenv";
import { createIsolatedTestDatabase } from "../src/test/isolated-database";
const source = process.env.SKILL_TEST_ENV_SOURCE;
if (!source)
  throw new Error(
    "SKILL_TEST_ENV_SOURCE must identify the admin connection env file",
  );
const values = parse(await readFile(source));
if (!values.DATABASE_URL) throw new Error("Source env has no DATABASE_URL");
process.env.DATABASE_URL = values.DATABASE_URL;
process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("hex");
process.env.MODEL_GATEWAY_ENCRYPTION_SECRET = randomBytes(32).toString("hex");
const isolated = await createIsolatedTestDatabase("skillv6");
const env = {
  DATABASE_URL: isolated.url,
  REDIS_URL: values.REDIS_URL ?? "redis://127.0.0.1:6379",
  BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
  MODEL_GATEWAY_ENCRYPTION_SECRET: process.env.MODEL_GATEWAY_ENCRYPTION_SECRET,
  JOB_QUEUE_NAME: `skillv6-${randomBytes(8).toString("hex")}`,
  MARKET_ADMIN_USER_IDS: "skill-test-admin",
  OPENROUTER_ENABLED: "false",
  ORCAROUTER_ENABLED: "false",
  NEXT_PUBLIC_API_BASE_URL: "http://localhost:3311",
  NEXT_PUBLIC_WEB_BASE_URL: "http://localhost:3310",
  BACKEND_API_PORT: "3311",
  BETTER_AUTH_URL: "http://localhost:3311",
  BETTER_AUTH_TRUSTED_ORIGINS: "http://localhost:3310",
  // Ingest writes every skill file and the bundle to object storage before it
  // touches the database, so the test deployment needs the same storage the
  // source env uses. Keys are content-addressed (`skills/blobs|bundles/<sha>`),
  // so runs cannot collide with each other or with real data.
  ...Object.fromEntries(
    [
      "S3_BUCKET",
      "S3_REGION",
      "S3_ENDPOINT",
      "S3_ACCESS_KEY_ID",
      "S3_SECRET_ACCESS_KEY",
      "S3_FORCE_PATH_STYLE",
      // Unauthenticated GitHub allows 60 requests/hour; one suite run exceeds it.
      "GITHUB_TOKEN",
      // The chat case (the agent installing a skill mid-conversation) needs a
      // real model; see `chatGatewayEnv` below.
      "DEEPSEEK_API_KEY",
      // The sandbox case (a skill's own script run in the cloud sandbox) uses
      // whichever provider the source deployment runs. Absent → BLOCKED.
      "SOURCEWEFT_SANDBOX_ENABLED",
      "SOURCEWEFT_SANDBOX_PROVIDER",
      "SOURCEWEFT_SANDBOX_TOOL_APPROVAL_ENABLED",
      "CF_SANDBOX_API_KEY",
      "CF_SANDBOX_BRIDGE_URL",
      "DAYTONA_API_URL",
      "DAYTONA_API_KEY",
      "DAYTONA_SANDBOX_SNAPSHOT",
      "DAYTONA_SANDBOX_IMAGE",
    ].flatMap((key) => (values[key] ? [[key, values[key]]] : [])),
  ),
};
/**
 * A minimal model-gateway config for the chat case: the source deployment's
 * DeepSeek gateway with the chat profiles it serves, plus the embedding
 * profiles the backend refuses to boot without (and whichever gateway serves
 * them). The full config cannot be reused — its other gateways reference env
 * vars this test deployment deliberately does not carry, and must not bill
 * against. Without a DeepSeek key in the source env there is no file, and the
 * chat case reports BLOCKED.
 */
async function chatGatewayEnv(): Promise<Record<string, string>> {
  type Target = { gatewaySlug?: string; targets?: Array<{ gatewaySlug: string }> };
  const sourcePath = values.MODEL_GATEWAY_GLOBAL_CONFIG_PATH;
  if (!sourcePath || !values.DEEPSEEK_API_KEY) return {};
  const full = JSON.parse(await readFile(sourcePath, "utf8")) as {
    gateways?: Array<{ slug: string; providerKind?: string; apiKeyEnv?: string }>;
    chatProfiles?: Target[];
    embeddingProfiles?: Target[];
  };
  const slugsOf = (profile: Target) => [
    ...(profile.gatewaySlug ? [profile.gatewaySlug] : []),
    ...(profile.targets ?? []).map((target) => target.gatewaySlug),
  ];
  const embeddingProfiles = full.embeddingProfiles ?? [];
  const wanted = new Set([
    ...(full.gateways ?? [])
      .filter((gateway) => gateway.providerKind === "deepseek")
      .map((gateway) => gateway.slug),
    ...embeddingProfiles.flatMap(slugsOf),
  ]);
  const gateways = (full.gateways ?? [])
    .filter((gateway) => wanted.has(gateway.slug))
    .map((gateway) => ({
      ...gateway,
      isDefault: gateway.providerKind === "deepseek",
    }));
  const chatProfiles = (full.chatProfiles ?? [])
    .map((profile) => ({
      ...profile,
      targets: (profile.targets ?? []).filter((target) =>
        wanted.has(target.gatewaySlug),
      ),
    }))
    .filter((profile) => profile.targets.length > 0);
  if (chatProfiles.length === 0 || embeddingProfiles.length === 0) return {};
  // Named `.env.*` so the repository's ignore rule covers it.
  const target = resolve(".env.skills-test.gateway.json");
  await writeFile(
    target,
    JSON.stringify({ gateways, chatProfiles, embeddingProfiles }, null, 2),
    { mode: 0o600 },
  );
  return {
    MODEL_GATEWAY_GLOBAL_CONFIG_PATH: target,
    ...Object.fromEntries(
      gateways.flatMap((gateway) =>
        gateway.apiKeyEnv && values[gateway.apiKeyEnv]
          ? [[gateway.apiKeyEnv, values[gateway.apiKeyEnv]!]]
          : [],
      ),
    ),
  };
}
Object.assign(env, await chatGatewayEnv());
try {
  await writeFile(
    resolve(".env.skills-test"),
    Object.entries(env)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join("\n") + "\n",
    { mode: 0o600 },
  );
} catch (error) {
  await isolated.close();
  throw error;
}
console.log(
  "Created isolated skill test database and .env.skills-test (credentials not printed)",
);
