/** Isolated real-process repair fault fixture. No cloud credentials or backend .env. */
import {
  readFileSync,
  writeFileSync,
  statSync,
  copyFileSync,
  openSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { VolumeService } from "../../src/service/volume-service";
import type { ObjectStore } from "../../src/store/object-store";
const [configPath, mode] = process.argv.slice(2);
if (!configPath || !["crash-after-copy", "resume"].includes(mode!))
  throw Error("invalid repair fixture arguments");
const config = JSON.parse(readFileSync(configPath, "utf8")) as {
  url: string;
  schema: string;
  directory: string;
  counter: string;
  volumeId: string;
  sourceKey: string;
  reservationKey?: string;
};
if (!/^repair_[0-9a-f]+$/.test(config.schema))
  throw Error("fixture schema is not an isolated repair schema");
const pool = new Pool({
  connectionString: config.url,
  options: `-c search_path=${config.schema}`,
  max: 1,
});
const disk = (key: string) =>
  join(config.directory, createHash("sha256").update(key).digest("hex"));
function syncPath(path: string) {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
const store: ObjectStore = {
  presignWriteOnce: async () => {
    throw Error("unexpected signing");
  },
  presignGet: async () => {
    throw Error("unexpected signing");
  },
  get: async (key, options) => {
    try {
      const size = statSync(disk(key)).size;
      if (options && size > options.maxBytes)
        throw Error("fixture read exceeds repair budget");
      return readFileSync(disk(key));
    } catch (error: any) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  },
  put: async () => {
    throw Error("unexpected PUT");
  },
  size: async () => {
    throw Error("size-only repair proof is forbidden");
  },
  deletePrefix: async () => {
    throw Error("bulk deletion forbidden");
  },
  copy: async (source, target) => {
    copyFileSync(disk(source), disk(target));
    syncPath(disk(target));
    syncPath(config.directory);
    const count = (() => {
      try {
        return Number(readFileSync(config.counter, "utf8"));
      } catch (error: any) {
        if (error.code === "ENOENT") return 0;
        throw error;
      }
    })();
    writeFileSync(config.counter, String(count + 1));
    syncPath(config.counter);
    // Both the target file and its directory have completed real fsync before this marker.
    if (mode === "crash-after-copy") {
      if (!process.send) throw Error("crash fixture requires an IPC parent");
      const keepAlive = setInterval(() => {}, 1000);
      process.send({
        phase: "copy-durable-before-finish",
        pid: process.pid,
        source,
        target,
      });
      await new Promise<void>(() => {});
      clearInterval(keepAlive);
    }
  },
};
try {
  const service = new VolumeService({
    db: drizzle(pool),
    store,
    keyPrefix: "repair-fixture/",
    limits: { maxObjectBytes: 8192 },
  });
  const key = await service.repairPack(
    config.volumeId,
    config.sourceKey,
    config.reservationKey ? { reservationKey: config.reservationKey } : {},
  );
  process.stdout.write(
    JSON.stringify({
      pid: process.pid,
      key,
      copies: Number(readFileSync(config.counter, "utf8")),
    }) + "\n",
  );
} finally {
  await pool.end();
}
