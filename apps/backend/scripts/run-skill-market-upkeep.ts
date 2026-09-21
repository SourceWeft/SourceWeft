import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "dotenv";

/**
 * One skill market upkeep pass (`scheduleSkillMarketUpkeep`) against the
 * isolated skill test deployment, for the e2e: submit → run a pass → assert
 * listed / provenance stamped / stars. The scheduler runs it every five
 * minutes; a test cannot wait for that.
 *
 * Run from `apps/backend`. Refuses any database but an isolated
 * `sourceweft_skillv6_*` one, like `reset-skills-e2e.ts`.
 */
const envPath = resolve(".env.skills-test");
const env = parse(await readFile(envPath));
if (!new URL(env.DATABASE_URL!).pathname.startsWith("/sourceweft_skillv6_"))
  throw new Error("Refusing non-isolated database");

// Before anything reads configuration: `shared/config` loads `dotenv/config`,
// which reads DOTENV_CONFIG_PATH, and never overrides a variable already set —
// so the test values are set here, over whatever the shell carries.
process.env.DOTENV_CONFIG_PATH = envPath;
Object.assign(process.env, env);

const { scheduleSkillMarketUpkeep } =
  await import("../src/scheduler/schedules/skill-market");
const { closeDatabase } = await import("@sourceweft/db");
const { closeQueue } = await import("../src/shared/queue");

let exitCode = 0;
try {
  await scheduleSkillMarketUpkeep();
  console.log("Skill market upkeep pass complete");
} catch (error) {
  exitCode = 1;
  console.error(
    "Skill market upkeep pass failed:",
    error instanceof Error ? error.message : String(error),
  );
} finally {
  await Promise.allSettled([closeDatabase(), closeQueue()]);
}
// Whatever a step left open (a Redis connection) must not keep the e2e waiting.
process.exit(exitCode);
