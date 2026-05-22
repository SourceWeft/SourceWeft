import { closeDatabase } from "../shared/database";
import { parseSyncLocale, syncNotionBlog } from "../modules/blog/sync";

type CliOptions = {
  dryRun: boolean;
  validateOnly: boolean;
  locale: string | null;
  articleId: string | null;
};

function parseArgs(argv: string[]) {
  const options: CliOptions = {
    dryRun: false,
    validateOnly: false,
    locale: null,
    articleId: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--validate-only") {
      options.validateOnly = true;
      continue;
    }
    if (arg === "--locale") {
      options.locale = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg === "--article-id") {
      options.articleId = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    throw new Error(`Unknown blog sync option: ${arg}`);
  }

  return options;
}

async function main() {
  const cliOptions = parseArgs(process.argv.slice(2));
  const result = await syncNotionBlog({
    dryRun: cliOptions.dryRun,
    validateOnly: cliOptions.validateOnly,
    locale: parseSyncLocale(cliOptions.locale ?? undefined),
    articleId: cliOptions.articleId,
  });

  console.info("Notion blog sync completed");
  console.table({
    scanned: result.scanned,
    validated: result.validated,
    upserted: result.upserted,
    hidden: result.hidden,
    skipped_not_public: result.skipped,
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
    await closeDatabase();
  });

