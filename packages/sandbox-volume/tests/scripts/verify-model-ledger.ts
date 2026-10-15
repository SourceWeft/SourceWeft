import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { VolumeRepository } from "../../src/service/repository";
import type { ManifestEntry } from "../../src/protocol/types";
const directory = process.argv[2],
  url = process.env.SANDBOX_VOLUME_TEST_DATABASE_URL;
if (!directory || !url)
  throw new Error(
    "provide a model evidence directory and explicit SANDBOX_VOLUME_TEST_DATABASE_URL",
  );
const root = resolve(directory);
const meta = JSON.parse(readFileSync(join(root, "meta.json"), "utf8")) as {
  version: number;
  schema: string;
  volumeId: string;
  keyPrefix: string;
  seed: number;
};
assert.equal(meta.version, 1);
assert.match(meta.schema, /^model_[0-9a-f]{32}$/);
const receipts = readFileSync(join(root, "confirmed.jsonl"), "utf8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map(
    (line) =>
      JSON.parse(line) as {
        seq: number;
        entries: ManifestEntry[];
        contents: Record<string, string>;
      },
  );
const pool = new Pool({
  connectionString: url,
  options: `-c search_path=${meta.schema}`,
});
try {
  const repo = new VolumeRepository(drizzle(pool));
  let files = 0;
  for (const receipt of receipts) {
    const rows = await repo.entriesAt(meta.volumeId, receipt.seq);
    const actual = rows
      .map((row) => ({
        p: row.path,
        k: row.kind,
        m: row.mode,
        t: row.mtimeNs.toString(),
        ...(row.kind === "f"
          ? { s: row.sizeBytes, c: row.chunks }
          : row.kind === "l"
            ? { l: row.linkTarget }
            : {}),
      }))
      .sort((a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0));
    assert.deepEqual(
      actual,
      receipt.entries,
      `confirmed seq ${receipt.seq} tree changed`,
    );
    const locations = await repo.chunkLocations(
      meta.volumeId,
      rows.flatMap((row) => row.chunks.map(([id]) => id)),
    );
    for (const entry of rows.filter((row) => row.kind === "f")) {
      const bytes = entry.chunks.map(([id]) => {
        const location = locations[id];
        assert.ok(location);
        const [key, off, len] = location;
        const file = join(
          root,
          "objects",
          createHash("sha256")
            .update(meta.keyPrefix + key)
            .digest("hex"),
        );
        return zstdDecompressSync(readFileSync(file).subarray(off, off + len));
      });
      assert.equal(
        Buffer.concat(bytes).toString(),
        receipt.contents[entry.path],
        `confirmed seq ${receipt.seq} bytes changed: ${entry.path}`,
      );
      files++;
    }
  }
  console.log(
    JSON.stringify({
      seed: meta.seed,
      schema: meta.schema,
      confirmedReceipts: receipts.length,
      confirmedFileVersions: files,
      verified: true,
      objectSource: "persisted local fixture (not S3)",
    }),
  );
} finally {
  await pool.end();
}
