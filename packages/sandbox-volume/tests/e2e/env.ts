import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  createS3ObjectStore,
  type ObjectStore,
} from "../../src/store/object-store";
import { VolumeService } from "../../src/service/volume-service";
import type { VolumeScope } from "../../src/service/repository";

/**
 * E2E uses an explicitly supplied test database and a generated private schema.
 * Existing application threads/volumes are never selected. An env file is read only
 * when SANDBOX_VOLUME_E2E_ENV_FILE names it explicitly.
 */
export function loadBackendEnv(): Record<string, string> {
  const out: Record<string, string> = { ...process.env } as Record<
    string,
    string
  >;
  const envFile = process.env.SANDBOX_VOLUME_E2E_ENV_FILE;
  if (envFile) {
    const text = readFileSync(resolve(envFile), "utf8");
    for (const line of text.split("\n")) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m && m[1] && !(m[1] in process.env))
        out[m[1]] = (m[2] ?? "").replace(/^["']|["']$/g, "");
    }
  }
  return out;
}

export const e2eEnabled = process.env.SANDBOX_VOLUME_E2E === "1";

export type E2EContext = {
  env: Record<string, string>;
  store: ObjectStore;
  service: VolumeService;
  pool: Pool;
  keyPrefix: string;
  scope: VolumeScope;
  close(): Promise<void>;
};

export function testConfiguration(env: Record<string, string>) {
  if (!env.SANDBOX_VOLUME_TEST_DATABASE_URL)
    throw new Error(
      "SANDBOX_VOLUME_TEST_DATABASE_URL must explicitly select a disposable test database",
    );
  if (!env.S3_BUCKET || !env.S3_REGION)
    throw new Error(
      "S3_BUCKET and S3_REGION are required for real object-store E2E",
    );
  const prefix = env.SANDBOX_VOLUME_TEST_PREFIX || "_swvol-e2e/";
  if (!/^_swvol-e2e\/(?:[A-Za-z0-9_-]+\/)*$/.test(prefix))
    throw new Error(
      "SANDBOX_VOLUME_TEST_PREFIX must remain under _swvol-e2e/ and contain only safe path segments",
    );
  return { databaseUrl: env.SANDBOX_VOLUME_TEST_DATABASE_URL, prefix };
}

export async function createE2EContext(): Promise<E2EContext> {
  const env = loadBackendEnv();
  const settings = testConfiguration(env);
  const schema = `swvol_e2e_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: settings.databaseUrl });
  const pool = new Pool({
    connectionString: settings.databaseUrl,
    options: `-c search_path=${schema}`,
  });
  const scope = {
    teamId: randomUUID(),
    workspaceId: randomUUID(),
    threadId: randomUUID(),
  };
  try {
    await admin.query(`create schema ${schema}`);
    await pool.query(`create table workspaces(id text primary key);
      create table threads(id text primary key, workspace_id text not null, team_id text not null, unique(id,workspace_id,team_id));`);
    const migrations = new URL("../../../db/drizzle/", import.meta.url);
    for (const name of readdirSync(migrations)
      .filter((name) => /^\d+_sandbox_volumes?[^/]*\.sql$/.test(name))
      .sort()) {
      await pool.query(
        readFileSync(new URL(name, migrations), "utf8").replaceAll(
          '"public".',
          `"${schema}".`,
        ),
      );
    }
    await pool.query("insert into workspaces values($1)", [scope.workspaceId]);
    await pool.query("insert into threads values($1,$2,$3)", [
      scope.threadId,
      scope.workspaceId,
      scope.teamId,
    ]);
  } catch (error) {
    await pool.end();
    try {
      await admin.query(`drop schema if exists ${schema} cascade`);
    } finally {
      await admin.end();
    }
    throw error;
  }
  const db = drizzle(pool, { casing: "snake_case" });
  const store = createS3ObjectStore({
    bucket: env.S3_BUCKET!,
    region: env.S3_REGION!,
    endpoint: env.S3_ENDPOINT || undefined,
    forcePathStyle: env.S3_FORCE_PATH_STYLE === "true",
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID || env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY || env.AWS_SECRET_ACCESS_KEY!,
    },
  });
  const keyPrefix = `${settings.prefix}${randomUUID()}/`;
  const service = new VolumeService({ db, store, keyPrefix });
  return {
    env,
    store,
    service,
    pool,
    keyPrefix,
    scope,
    async close() {
      await pool.end();
      try {
        await admin.query(`drop schema ${schema} cascade`);
      } finally {
        await admin.end();
      }
    },
  };
}

/** Delete every test row for this scope (volumes cascade) — called at the end of a test file. */
export async function cleanupVolume(ctx: E2EContext, volumeId: string) {
  await ctx.pool.query(
    "delete from sandbox_volumes where id = $1 and thread_id = $2 and workspace_id = $3 and team_id = $4",
    [volumeId, ctx.scope.threadId, ctx.scope.workspaceId, ctx.scope.teamId],
  );
}

/** Upload through a pre-signed write-once URL exactly like the helper does. */
export async function putWriteOnce(
  url: string,
  body: Uint8Array,
  withCondition = true,
): Promise<number> {
  const response = await fetch(url, {
    method: "PUT",
    headers: withCondition ? { "If-None-Match": "*" } : {},
    body: body as unknown as BodyInit,
  });
  await response.arrayBuffer();
  return response.status;
}
