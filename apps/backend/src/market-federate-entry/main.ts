// First: it loads the environment, which the database module reads on import.
import "../shared/config";
import { closeDatabase } from "@sourceweft/db";
import { closeQueue } from "../shared/queue";
import {
  DEFAULT_REGISTRY_SOURCES,
  federateRegistryEntry,
} from "../modules/market/federation";

/**
 * Operator command: federate one upstream registry entry now, without waiting
 * for the scheduled walk to reach it. Ships in the backend image as
 * `dist/market-federate-entry.js`, so it runs on the deployed version's code
 * and schema by construction; run it in a backend container (the scheduler's,
 * say) where the database and queue are configured.
 *
 *   node dist/market-federate-entry.js io.github.arcmira/arcmira
 *   node dist/market-federate-entry.js <identifier> --source <registry source>
 *
 * The answer is the one stdout line that starts with RESULT_PREFIX — the logger
 * shares stdout. Exit code 0 means the entry was found and upserted; 1 means it
 * was not (unknown identifier, upsert failure, no database).
 */
export const RESULT_PREFIX = "MARKET_FEDERATE_ENTRY_RESULT ";

function parseArguments(argv: string[]) {
  const positional: string[] = [];
  let sourceName: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--source") {
      sourceName = argv[index + 1];
      index += 1;
    } else if (argument.startsWith("--")) {
      throw new Error(`Unknown option ${argument}`);
    } else {
      positional.push(argument);
    }
  }
  const identifier = positional[0]?.trim();
  if (!identifier || positional.length > 1) {
    throw new Error(
      "Usage: market-federate-entry.js <registry identifier> [--source <registry source>]",
    );
  }
  const source = sourceName
    ? DEFAULT_REGISTRY_SOURCES.find((entry) => entry.source === sourceName)
    : DEFAULT_REGISTRY_SOURCES[0];
  if (!source) {
    throw new Error(
      `Unknown registry source "${sourceName}"; expected one of: ${DEFAULT_REGISTRY_SOURCES.map((entry) => entry.source).join(", ")}`,
    );
  }
  return { identifier, source };
}

/**
 * Resolves once the text has been handed to the OS: writes to a pipe are
 * asynchronous, and `process.exit` does not wait for them.
 */
function writeFully(stream: NodeJS.WriteStream, text: string) {
  return new Promise<void>((resolve) => stream.write(text, () => resolve()));
}

let exitCode = 0;
try {
  const { identifier, source } = parseArguments(process.argv.slice(2));
  const result = await federateRegistryEntry({ identifier, source });
  if (!result.found || result.ingested !== 1) exitCode = 1;
  await writeFully(
    process.stdout,
    `${RESULT_PREFIX}${JSON.stringify({ source: source.source, ...result })}\n`,
  );
} catch (error) {
  exitCode = 1;
  await writeFully(
    process.stderr,
    `market-federate-entry: ${error instanceof Error ? error.message : String(error)}\n`,
  );
} finally {
  await Promise.allSettled([closeQueue(), closeDatabase()]);
}
process.exit(exitCode);
