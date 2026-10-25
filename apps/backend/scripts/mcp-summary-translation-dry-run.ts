import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

/**
 * The summary translation's review sample (Issue #367): the next entries the
 * pass would translate, run through the real system model, written as JSON
 * and printed — original, detected language, Simplified Chinese and the
 * OpenCC + glossary Traditional Chinese side by side. Nothing is stored. Every
 * zh-TW line is generated, so review them all; a wrong term is fixed in
 * `packages/i18n/glossary/zh-TW.json`, never by editing a stored text. Reads
 * the database named by DATABASE_URL and needs the SYSTEM_MODEL_* settings.
 * Run from `apps/backend`:
 *
 *   pnpm exec tsx scripts/mcp-summary-translation-dry-run.ts [--limit 40] [--out <file.json>]
 *
 * The default output is under the repository's local-only `.docs/` folder.
 */
const { values } = parseArgs({
  options: {
    limit: { type: "string", default: "40" },
    out: { type: "string" },
  },
});
const limit = Number(values.limit);
if (!Number.isInteger(limit) || limit < 1) {
  throw new Error("--limit must be a positive integer");
}
const out = resolve(
  values.out ??
    `../../.docs/mcp-summary-translation/dry-run-${new Date().toISOString().slice(0, 10)}.json`,
);

const { closeDatabase } = await import("@sourceweft/db");
const { runSummaryTranslationPass } = await import(
  "../src/modules/market/metadata/summary-translation-run"
);

try {
  const result = await runSummaryTranslationPass({ limit, dryRun: true });
  if (result.skipped) {
    throw new Error(
      "The system model is not ready (SYSTEM_MODEL_ENABLED, _PROVIDER, _API_KEY, _NAME): nothing was translated",
    );
  }
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(result.reports, null, 2));
  for (const report of result.reports) {
    console.log(`\n[${report.outcome}] ${report.identifier}`);
    console.log(`  ${report.record.sourceLanguage}: ${report.summary}`);
    if (report.record["zh-CN"]) console.log(`  zh-CN: ${report.record["zh-CN"]}`);
    if (report.record["zh-TW"]) console.log(`  zh-TW: ${report.record["zh-TW"]}`);
  }
  console.log(`\n${result.reports.length} entries → ${out}`);
} finally {
  await closeDatabase();
}
