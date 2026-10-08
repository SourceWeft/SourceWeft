import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { VolumeService } from "../../src/service/volume-service";
import { encodeManifestObject } from "../../src/protocol/manifest";
import type { ObjectStore } from "../../src/store/object-store";
const [url, schema, volume, attachment] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
];
const pool = new Pool({
  connectionString: url,
  options: `-c search_path=${schema}`,
});
const raw = encodeManifestObject({
  v: 1,
  volume,
  attachment,
  seq: 1,
  base: 0,
  upserts: [{ p: "multiprocess", k: "d", m: 493 }],
});
const store = {
  get: async (key: string) => (key.endsWith("/m/0/1") ? raw : null),
} as unknown as ObjectStore;
try {
  const result = await new VolumeService({
    db: drizzle(pool),
    store,
    keyPrefix: "process/",
  }).applyWal(attachment);
  process.stdout.write(JSON.stringify(result));
} finally {
  await pool.end();
}
