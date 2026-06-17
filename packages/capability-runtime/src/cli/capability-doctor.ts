import { resolve } from "node:path";
import { discoverCapabilities, summarizeCapabilityRegistry } from "../index";

type DoctorOptions = {
  readonly root: string;
  readonly strict: boolean;
  readonly json: boolean;
};

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const result = await discoverCapabilities({ roots: [resolve(options.root)] });
  const summary = summarizeCapabilityRegistry(
    result.records,
    result.diagnostics,
  );
  const payload = {
    ...summary,
    ids: result.records.map((record) => record.manifest.id),
    diagnostics: {
      ...summary.diagnostics,
      items: result.diagnostics,
    },
  };

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(payload);
  }

  if (options.strict && summary.diagnostics.errorCount > 0) {
    process.exitCode = 1;
  }
}

function parseArgs(args: readonly string[]): DoctorOptions {
  let root = "../../packages";
  let strict = false;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--root") {
      const next = args[index + 1];
      if (!next) {
        throw new Error("--root requires a path");
      }
      root = next;
      index += 1;
      continue;
    }
    if (arg === "--strict") {
      strict = true;
      continue;
    }
    if (arg === "--json") {
      json = true;
    }
  }
  return { root, strict, json };
}

await main();
