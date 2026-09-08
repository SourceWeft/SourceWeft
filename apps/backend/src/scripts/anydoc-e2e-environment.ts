/** Run from apps/backend with tsx; creates only a dedicated E2E database. */
import "dotenv/config";
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import Redis from "ioredis";
import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { createIsolatedTestDatabase } from "../test/isolated-database";

const root = new URL("../../../../", import.meta.url);
const statePath = new URL(
  "output/playwright/anydoc/environment.private.json",
  root,
);
type State = { originalDatabaseUrl: string; isolatedDatabaseUrl: string };
const mode = process.argv[2] ?? "preflight";
async function replaceDatabase(url: string) {
  for (const relative of ["apps/backend/.env", "apps/web/.env.local"]) {
    const path = new URL(relative, root);
    const original = await readFile(path, "utf8");
    const lines = original
      .split("\n")
      .filter((line) => !/^DATABASE_URL=/.test(line));
    await writeFile(path, lines.join("\n") + `\nDATABASE_URL=${url}\n`, {
      mode: 0o600,
    });
  }
}

if (mode === "prepare") {
  try {
    await readFile(statePath);
    throw new Error("E2E state already exists; do not create another database");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (
    process.env.JOB_QUEUE_NAME !== "sourceweft-anydoc-e2e" ||
    process.env.BACKEND_API_PORT !== "3101"
  ) {
    throw new Error(
      "Configure independent E2E queue and API port before prepare",
    );
  }
  const originalDatabaseUrl = process.env.DATABASE_URL;
  if (!originalDatabaseUrl) throw new Error("DATABASE_URL is required");
  const isolated = await createIsolatedTestDatabase("anydoc_e2e");
  await mkdir(new URL("output/playwright/anydoc/", root), { recursive: true });
  await writeFile(
    statePath,
    JSON.stringify({
      originalDatabaseUrl,
      isolatedDatabaseUrl: isolated.url,
    } satisfies State),
    { mode: 0o600 },
  );
  await replaceDatabase(isolated.url);
  console.log(
    "Created and migrated isolated AnyDoc E2E database; both private env files updated.",
  );
} else if (mode === "cleanup") {
  const state = JSON.parse(await readFile(statePath, "utf8")) as State;
  const name = new URL(state.isolatedDatabaseUrl).pathname.slice(1);
  if (!/^sourceweft_anydoc_e2e_[a-f0-9]{32}$/.test(name))
    throw new Error("Refusing unexpected database name");
  const client = new Client({ connectionString: state.originalDatabaseUrl });
  try {
    await client.connect();
    await client.query(`drop database "${name}"`);
  } finally {
    await client.end();
  }
  await replaceDatabase(state.originalDatabaseUrl);
  await unlink(statePath);
  console.log(
    "Dropped isolated database and restored original database settings. Delete test source records and their scoped storage objects before this cleanup.",
  );
} else if (mode === "preflight") {
  for (const name of [
    "DATABASE_URL",
    "REDIS_URL",
    "S3_BUCKET",
    "PDF2MARKDOWN_API_KEY",
  ]) {
    if (!process.env[name]?.trim()) throw new Error(`${name} is missing`);
  }
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 10000,
  });
  try {
    await client.connect();
    await client.query("select 1");
    console.log("PostgreSQL reachable");
  } finally {
    await client.end();
  }
  const redis = new Redis(process.env.REDIS_URL!, {
    lazyConnect: true,
    connectTimeout: 10000,
    retryStrategy: () => null,
  });
  redis.on("error", () => {});
  try {
    await redis.connect();
    if ((await redis.ping()) !== "PONG") throw new Error("Redis PING failed");
    console.log("Redis reachable");
  } finally {
    redis.disconnect();
  }
  const key = process.env.AWS_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY_ID;
  const secret =
    process.env.AWS_SECRET_ACCESS_KEY || process.env.S3_SECRET_ACCESS_KEY;
  const storage = new S3Client({
    region: process.env.S3_REGION || "us-east-1",
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
    credentials:
      key && secret ? { accessKeyId: key, secretAccessKey: secret } : undefined,
    maxAttempts: 1,
  });
  try {
    await storage.send(
      new HeadBucketCommand({ Bucket: process.env.S3_BUCKET }),
      { abortSignal: AbortSignal.timeout(15000) },
    );
    console.log(
      "S3 bucket reachable (read-only HEAD; uploads/CORS still require E2E)",
    );
  } finally {
    storage.destroy();
  }
  console.log(
    "PDF2Markdown credential present; OCR and embedding capability require live document execution.",
  );
  console.log(
    `Artifact directory: ${fileURLToPath(new URL("output/playwright/anydoc/", root))}`,
  );
} else throw new Error("Expected preflight, prepare, or cleanup");
