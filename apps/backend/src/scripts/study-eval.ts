import "dotenv/config";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { closeDatabase } from "@sourceweft/db";
import { STUDY_ARTIFACT_TYPES, type StudyKind } from "@sourceweft/contracts/study";
import { billingRuntime } from "../billing-host/bindings";
import { syncGlobalModelGatewayConfig } from "../shared/model-gateway/config-sync";
import {
  loadStudyEvalFixtures,
  STUDY_EVAL_PILOT_IDS,
  type StudyEvalFixture,
} from "../modules/study/eval/fixtures";
import {
  createRecordingBilling,
  ensureEvalPrincipal,
  judgeJob,
  runFixtureKind,
  seedFixture,
  type EvalJobRecord,
  type SeededFixture,
} from "../modules/study/eval/runner";
import { STUDY_EVAL_JUDGE_OPERATION } from "../modules/study/eval/judge";
import {
  renderStudyEvalMarkdown,
  summarizeStudyEval,
} from "../modules/study/eval/report";

/**
 * Study evaluation (plan §10, Issue #572): generates flashcards, quizzes and
 * mind maps from the evaluation fixtures through the real study generation
 * (default chat model, billed model port, real evidence anchoring), judges
 * every item, and writes a report of each B2 metric against its gate.
 *
 * Manual only, never in CI: it makes real, paid model calls. It writes source
 * rows into the database DATABASE_URL names, so run it against a throwaway,
 * migrated database and name that database with --database to confirm. It
 * syncs the gateway configuration (MODEL_GATEWAY_GLOBAL_CONFIG_PATH) with
 * prices, as the scheduler does. Usage and cost are read from the billing
 * port's settlements, so the core billing runtime (commercial module off) is
 * enough and no credits are drawn:
 *
 *   SOURCEWEFT_COMMERCIAL_ENABLED=false SOURCEWEFT_SAAS_ENABLED=false \
 *   DATABASE_URL=postgres://…/sourceweft_study_eval \
 *   pnpm --filter @sourceweft/backend exec tsx src/scripts/study-eval.ts \
 *     --database sourceweft_study_eval --pilot --out ../../.docs/study-eval
 *
 * Options:
 *   --database <name>    required; must equal the database in DATABASE_URL
 *   --pilot              the eight approved pilot sets (default)
 *   --fixtures a,b       these sets instead
 *   --all                every set (the full evaluation; needs approval of its spend)
 *   --kinds k1,k2        a subset of flashcards,quiz,mindmap (default: all three)
 *   --no-judge           skip the judge pass
 *   --judge-concurrency  parallel judge calls per job (default 4)
 *   --out <dir>          where the JSON and markdown reports go (default: cwd)
 */

function option(name: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

function databaseName(url: string | undefined) {
  if (!url) return null;
  try {
    return new URL(url).pathname.replace(/^\//, "") || null;
  } catch {
    return null;
  }
}

async function main() {
  const confirm = option("database");
  const actual = databaseName(process.env.DATABASE_URL);
  if (!confirm || confirm !== actual) {
    throw new Error(
      `Refusing to run: pass --database ${actual ?? "<name>"} to confirm the database the evaluation writes to`,
    );
  }

  const all = await loadStudyEvalFixtures();
  const byId = new Map(all.map((fixture) => [fixture.id, fixture]));
  const wanted = flag("all")
    ? all.map((fixture) => fixture.id)
    : (option("fixtures")?.split(",").map((id) => id.trim()) ?? [...STUDY_EVAL_PILOT_IDS]);
  const unknown = wanted.filter((id) => !byId.has(id));
  if (unknown.length > 0) throw new Error(`Unknown fixture(s): ${unknown.join(", ")}`);
  const fixtures = wanted.map((id) => byId.get(id)!) as StudyEvalFixture[];

  const kinds = (option("kinds")?.split(",").map((kind) => kind.trim()) ?? [
    ...STUDY_ARTIFACT_TYPES,
  ]) as StudyKind[];
  const badKinds = kinds.filter((kind) => !STUDY_ARTIFACT_TYPES.includes(kind));
  if (badKinds.length > 0) throw new Error(`Unknown kind(s): ${badKinds.join(", ")}`);
  const judgeConcurrency = Number(option("judge-concurrency") ?? 4);
  const outDir = option("out") ?? process.cwd();
  const runId = `${new Date().toISOString().slice(0, 10).replaceAll("-", "")}${randomBytes(3).toString("hex")}`;

  // As the scheduler does at startup: the gateway configuration and its prices.
  await syncGlobalModelGatewayConfig();
  await ensureEvalPrincipal();
  const { billing, records: usage } = createRecordingBilling(billingRuntime);

  console.log(`study-eval ${runId}: ${fixtures.length} set(s) × ${kinds.join(", ")}`);
  const seeded = new Map<string, SeededFixture>();
  const records: EvalJobRecord[] = [];
  for (const fixture of fixtures) {
    const stored = await seedFixture(fixture, runId);
    seeded.set(fixture.id, stored);
    for (const kind of kinds) {
      const record = await runFixtureKind({ fixture, seeded: stored, kind, runId, billing });
      const line =
        record.status === "ready"
          ? `${record.stats?.kept}/${record.stats?.requested} kept, ${record.mode}`
          : `FAILED ${record.errorCode ?? ""} ${record.errorMessage ?? ""}`;
      console.log(`  ${fixture.id} ${kind}: ${line} (${(record.durationMs / 1000).toFixed(1)} s)`);
      if (record.status === "ready" && !flag("no-judge")) {
        record.judge = await judgeJob({
          record,
          seeded: stored,
          runId,
          billing,
          concurrency: judgeConcurrency,
        });
      }
      records.push(record);
    }
  }

  const modelOf = (filter: (operation: string) => boolean) => {
    const models = [
      ...new Set(
        usage
          .filter((entry) => filter(entry.operation))
          .map((entry) => `${entry.profileAlias} → ${entry.providerModel ?? entry.modelAlias ?? "?"}`),
      ),
    ];
    return models.length > 0 ? models.join(", ") : null;
  };
  const summary = summarizeStudyEval({
    runId,
    fixtures: byId,
    seeded,
    records,
    usage,
    generationModel: modelOf((operation) => operation.startsWith("study.") && operation !== STUDY_EVAL_JUDGE_OPERATION),
    judgeModel: flag("no-judge") ? null : modelOf((operation) => operation === STUDY_EVAL_JUDGE_OPERATION),
  });

  await mkdir(outDir, { recursive: true });
  const base = join(outDir, `study-eval-${runId}`);
  await writeFile(`${base}.json`, `${JSON.stringify({ summary, records, usage }, null, 2)}\n`);
  await writeFile(`${base}.md`, renderStudyEvalMarkdown(summary));
  console.log(renderStudyEvalMarkdown(summary));
  console.log(`Reports: ${base}.json, ${base}.md`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
