import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const MARKET_DIR = path.dirname(fileURLToPath(import.meta.url));
const MODULES_DIR = path.dirname(MARKET_DIR);

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...tsFiles(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

// Keep the market module self-contained so it can be extracted into an
// independent service later (the "operate the market independently" option)
// without unpicking couplings. It may depend on @sourceweft/db, contracts, and
// ../../shared/*, but never on a sibling backend module (mcp, workspace,
// threads, …). If this fails, move the shared code into ../../shared or
// packages/* instead of reaching across modules.
test("market module does not import sibling backend modules", () => {
  const importRe = /from\s+["']([^"']+)["']/g;
  const violations: string[] = [];

  for (const file of tsFiles(MARKET_DIR)) {
    const source = readFileSync(file, "utf8");
    let match: RegExpExecArray | null;
    while ((match = importRe.exec(source)) !== null) {
      const spec = match[1];
      if (!spec.startsWith(".")) {
        continue; // packages + node builtins are fine
      }
      const resolved = path.resolve(path.dirname(file), spec);
      const insideMarket =
        resolved === MARKET_DIR || resolved.startsWith(MARKET_DIR + path.sep);
      const insideModules = resolved.startsWith(MODULES_DIR + path.sep);
      if (!insideMarket && insideModules) {
        violations.push(`${path.relative(MODULES_DIR, file)} → ${spec}`);
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    `market must stay self-contained; cross-module imports found:\n${violations.join("\n")}`,
  );
});
