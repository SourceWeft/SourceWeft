import { runChecks } from "../checks";
import { overallCheckStatus, type CheckResult } from "../checks/types";

function parseArgs(argv: string[]) {
  return {
    json: argv.includes("--json"),
    names: argv.filter((arg) => arg !== "--json"),
  };
}

function printTextResult(result: CheckResult) {
  console.log(`${result.name}: ${result.status}`);
  console.log(`  ${result.message}`);

  if (result.details && Object.keys(result.details).length > 0) {
    console.log(`  details: ${JSON.stringify(result.details)}`);
  }

  if (result.hints && result.hints.length > 0) {
    console.log("  hints:");
    for (const hint of result.hints) {
      console.log(`  - ${hint}`);
    }
  }

  console.log(`  durationMs: ${result.durationMs}`);
}

const args = parseArgs(process.argv.slice(2));
const results = await runChecks({
  names: args.names,
  context: {
    json: args.json,
  },
});
const status = overallCheckStatus(results);

if (args.json) {
  console.log(JSON.stringify({ status, checks: results }, null, 2));
} else {
  for (const result of results) {
    printTextResult(result);
  }
  console.log(`overall: ${status}`);
}

process.exit(status === "error" ? 1 : 0);
