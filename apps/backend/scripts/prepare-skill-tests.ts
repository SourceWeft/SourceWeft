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
};
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
