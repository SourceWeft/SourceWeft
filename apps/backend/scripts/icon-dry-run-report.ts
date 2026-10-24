import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

/**
 * The icon dry-run's review sample (Issue #367): 200 randomly selected,
 * stratified-by-source entries whose dry-run decision differs from the icon
 * the pages show today, written as an HTML page (old and new image side by
 * side, tier and reasons) plus the same rows as JSON. Reads the database named
 * by DATABASE_URL; writes only the two files. Run from `apps/backend`:
 *
 *   pnpm exec tsx scripts/icon-dry-run-report.ts [--size 200] [--seed 1] [--out <file.html>]
 *
 * The default output is under the repository's local-only `.docs/` folder.
 */
const { values } = parseArgs({
  options: {
    size: { type: "string", default: "200" },
    seed: { type: "string", default: "1" },
    out: { type: "string" },
  },
});
const size = Number(values.size);
const seed = Number(values.seed);
if (!Number.isInteger(size) || size < 1 || !Number.isInteger(seed)) {
  throw new Error("--size and --seed must be integers (size ≥ 1)");
}
const generatedAt = new Date();
const out = resolve(
  values.out ??
    `../../.docs/icon-dry-run/review-${generatedAt.toISOString().slice(0, 10)}.html`,
);

const { closeDatabase } = await import("@sourceweft/db");
const { findReviewRows } = await import(
  "../src/modules/market/icons/icon-dry-run-repository"
);
const { renderReviewHtml, selectReviewSample } = await import(
  "../src/modules/market/icons/review-sample"
);

try {
  const rows = await findReviewRows();
  const { sample, summary } = selectReviewSample(rows, { size, seed });
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, renderReviewHtml(sample, summary, generatedAt));
  const jsonOut = out.replace(/\.html$/, "") + ".json";
  await writeFile(jsonOut, JSON.stringify({ summary, sample }, null, 2));
  console.log(
    `Icon dry-run review: ${summary.differing} of ${summary.entriesWithDecision} decisions differ; ${sample.length} sampled`,
  );
  console.log(JSON.stringify(summary.sampled));
  console.log(`Wrote ${out}\nWrote ${jsonOut}`);
} finally {
  await closeDatabase();
}
