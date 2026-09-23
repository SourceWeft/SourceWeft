import { parseSystemSubmitCommand } from "./arguments";
// First: it loads the environment, which the database module reads on import.
import "../shared/config";
import { closeDatabase } from "@sourceweft/db";
import { closeQueue } from "../shared/queue";
import {
  parseSystemSubmitSources,
  readSystemSubmissions,
  submitSkillSourcesAsSystem,
} from "../modules/skills/registry/ingest/system-submit";

/**
 * Command line for the platform's own skill imports (the skills-sync tool).
 * Ships in the backend image as `dist/skills-submit.js`, so whatever runs it is
 * on the deployed version's schema and queue format by construction.
 *
 *   node dist/skills-submit.js submit   stdin: {"sources": [...]}
 *     each source is a URL string, or {"source": "<url>", "featured": true|false}
 *   node dist/skills-submit.js status   stdin: {"ids": [...]}
 *
 * The answer is the one stdout line that starts with RESULT_PREFIX — the logger
 * shares stdout. Exit code 0 means the command ran; per-item failures are in
 * the answer. Non-zero means nothing was attempted (bad arguments, bad scope,
 * no database or queue).
 */
export const RESULT_PREFIX = "SKILLS_SUBMIT_RESULT ";

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
  const command = parseSystemSubmitCommand(process.argv.slice(2));
  const input = await readStdinJson();
  return command === "submit"
    ? {
        submissions: await submitSkillSourcesAsSystem(
          parseSystemSubmitSources(input.sources),
        ),
      }
    : {
        submissions: await readSystemSubmissions(stringList(input.ids, "ids")),
      };
}

/**
 * Resolves once the text has been handed to the OS. Writes to a pipe are
 * asynchronous, and `process.exit` does not wait for them: an answer past the
 * pipe's buffer (64 KiB — a hundred imports) was cut off mid-JSON.
 */
function writeFully(stream: NodeJS.WriteStream, text: string) {
  return new Promise<void>((resolve) => stream.write(text, () => resolve()));
}

let exitCode = 0;
try {
  await writeFully(
    process.stdout,
    `${RESULT_PREFIX}${JSON.stringify(await run())}\n`,
  );
} catch (error) {
  exitCode = 1;
  await writeFully(
    process.stderr,
    `skills-submit: ${error instanceof Error ? error.message : String(error)}\n`,
  );
} finally {
  await Promise.allSettled([closeQueue(), closeDatabase()]);
}
process.exit(exitCode);
