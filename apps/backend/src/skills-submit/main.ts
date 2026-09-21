// First: it loads the environment, which the database module reads on import.
import "../shared/config";
import { closeDatabase } from "@sourceweft/db";
import { closeQueue } from "../shared/queue";
import {
  assertSystemSubmitScope,
  parseSystemSubmitSources,
  readSystemSubmissions,
  submitSkillSourcesAsSystem,
} from "../modules/skills/registry/ingest/system-submit";

/**
 * Command line for the platform's own skill imports (the skills-sync tool).
 * Ships in the backend image as `dist/skills-submit.js`, so whatever runs it is
 * on the deployed version's schema and queue format by construction.
 *
 *   node dist/skills-submit.js submit --team <id> --workspace <id>   stdin: {"sources": [...]}
 *     each source is a URL string, or {"source": "<url>", "featured": true|false}
 *   node dist/skills-submit.js status --team <id> --workspace <id>   stdin: {"ids": [...]}
 *
 * The answer is the one stdout line that starts with RESULT_PREFIX — the logger
 * shares stdout. Exit code 0 means the command ran; per-item failures are in
 * the answer. Non-zero means nothing was attempted (bad arguments, bad scope,
 * no database or queue).
 */
export const RESULT_PREFIX = "SKILLS_SUBMIT_RESULT ";

function argument(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing --${name}`);
  }
  return value;
}

async function readStdinJson(): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("stdin must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function stringList(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || !item.trim())
  ) {
    throw new Error(`stdin.${field} must be an array of non-empty strings`);
  }
  return value as string[];
}

async function run() {
  const command = process.argv[2];
  if (command !== "submit" && command !== "status") {
    throw new Error(
      "Usage: skills-submit <submit|status> --team <id> --workspace <id>",
    );
  }
  const scope = {
    teamId: argument("team"),
    workspaceId: argument("workspace"),
  };
  const input = await readStdinJson();
  await assertSystemSubmitScope(scope);
  return command === "submit"
    ? {
        submissions: await submitSkillSourcesAsSystem(
          scope,
          parseSystemSubmitSources(input.sources),
        ),
      }
    : {
        submissions: await readSystemSubmissions(
          scope,
          stringList(input.ids, "ids"),
        ),
      };
}

let exitCode = 0;
try {
  process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(await run())}\n`);
} catch (error) {
  exitCode = 1;
  process.stderr.write(
    `skills-submit: ${error instanceof Error ? error.message : String(error)}\n`,
  );
} finally {
  await Promise.allSettled([closeQueue(), closeDatabase()]);
}
process.exit(exitCode);
