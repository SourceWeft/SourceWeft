import { resolve } from "node:path";
import { importMarkdownBlog } from "../modules/blog/import-markdown";

type CliOptions = {
  dir: string | null;
  dryRun: boolean;
  validateOnly: boolean;
};

function parseArgs(argv: string[]) {
  const options: CliOptions = { dir: null, dryRun: false, validateOnly: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--validate-only") {
      options.validateOnly = true;
      continue;
    }
    if (arg === "--dir") {
      options.dir = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    throw new Error(`Unknown blog import option: ${arg}`);
  }

  return options;
}

// Validation and dry runs never open the database, so there is nothing to
// close and no connection settings are needed for them.
let writesRows = false;

async function main() {
  const cliOptions = parseArgs(process.argv.slice(2));
  if (!cliOptions.dir) {
    throw new Error("Usage: blog:import -- --dir <path> [--dry-run] [--validate-only]");
  }

  writesRows = !cliOptions.dryRun && !cliOptions.validateOnly;
  const result = await importMarkdownBlog({
    // pnpm runs the script from the package folder; resolve against where the
    // user typed the command.
    dir: resolve(process.env.INIT_CWD ?? process.cwd(), cliOptions.dir),
    dryRun: cliOptions.dryRun,
    validateOnly: cliOptions.validateOnly,
  });

  console.info("Markdown blog import completed");
  console.table({
    scanned: result.scanned,
    validated: result.validated,
    upserted: result.upserted,
    published: result.published,
    dry_run: result.dryRun,
    validate_only: result.validateOnly,
  });
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (writesRows) {
      const { closeDatabase } = await import("@sourceweft/db");
      await closeDatabase();
    }
  });
