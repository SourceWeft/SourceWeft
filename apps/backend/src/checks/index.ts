import { runBillingCatalogCheck } from "./billing-catalog";
import { runStorageCheck } from "./storage";
import type { CheckContext, CheckResult, CheckRunner } from "./types";

const implementedChecks: Record<string, CheckRunner> = {
  "billing-catalog": () => runBillingCatalogCheck(),
  storage: () => runStorageCheck(),
};

const plannedChecks = new Set(["pdf2markdown"]);

function normalizeRequestedChecks(input: string[]) {
  const requested = input
    .flatMap((item) => item.split(","))
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  if (requested.length === 0 || requested.includes("all")) {
    return Object.keys(implementedChecks);
  }

  return requested;
}

function skippedResult(name: string): CheckResult {
  return {
    name,
    status: "skipped",
    message: "Check is not implemented yet.",
    durationMs: 0,
  };
}

function unknownResult(name: string): CheckResult {
  return {
    name,
    status: "error",
    message: `Unknown check '${name}'. Available checks: ${Object.keys(implementedChecks).join(", ")}`,
    durationMs: 0,
  };
}

export async function runChecks(input: {
  names: string[];
  context: CheckContext;
}) {
  const names = normalizeRequestedChecks(input.names);
  const results: CheckResult[] = [];

  for (const name of names) {
    const runner = implementedChecks[name];
    if (runner) {
      results.push(await runner(input.context));
      continue;
    }

    results.push(plannedChecks.has(name) ? skippedResult(name) : unknownResult(name));
  }

  return results;
}
