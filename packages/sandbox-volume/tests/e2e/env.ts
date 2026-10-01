import { readFileSync } from "node:fs";
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
 * E2E tests run against the developer's own backend environment (`apps/backend/.env`): the local
 * Postgres and the private bucket. Everything they write goes under `SANDBOX_VOLUME_TEST_PREFIX`
 * (default `_swvol-e2e/`) and is deleted at the end. Set SANDBOX_VOLUME_E2E=1 to enable them.
 */
export function loadBackendEnv(): Record<string, string> {
  const out: Record<string, string> = { ...process.env } as Record<
    string,
    string
  >;
  try {
    const text = readFileSync(
      resolve(process.cwd(), "../../apps/backend/.env"),
      "utf8",
    );
    for (const line of text.split("\n")) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m && m[1] && !(m[1] in process.env))
        out[m[1]] = (m[2] ?? "").replace(/^["']|["']$/g, "");
    }
  } catch {
    // no env file: rely on the process environment
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

export async function createE2EContext(): Promise<E2EContext> {
  const env = loadBackendEnv();
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  const db = drizzle(pool, { casing: "snake_case" });
  const store = createS3ObjectStore({
    bucket: env.S3_BUCKET!,
    region: env.S3_REGION || "auto",
    endpoint: env.S3_ENDPOINT || undefined,
    forcePathStyle: env.S3_FORCE_PATH_STYLE === "true",
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID || env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY || env.AWS_SECRET_ACCESS_KEY!,
    },
  });
  const keyPrefix = `${(env.SANDBOX_VOLUME_TEST_PREFIX || "_swvol-e2e/").replace(/\/?$/, "/")}${Date.now().toString(36)}/`;
  const service = new VolumeService({ db, store, keyPrefix });
  const row = await pool.query(
    "select id, team_id, workspace_id from threads limit 1",
  );
  if (!row.rows[0])
    throw new Error("the e2e tests need at least one thread in the database");
  const scope = {
    teamId: row.rows[0].team_id,
    workspaceId: row.rows[0].workspace_id,
    threadId: row.rows[0].id,
  };
  return {
    env,
    store,
    service,
    pool,
    keyPrefix,
    scope,
    async close() {
      await pool.end();
    },
  };
}

/** Delete every test row for this scope (volumes cascade) — called at the end of a test file. */
export async function cleanupVolume(ctx: E2EContext, volumeId: string) {
  await ctx.pool.query("delete from sandbox_volumes where id = $1", [volumeId]);
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
