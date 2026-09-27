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

// The catalog overview engine: kind-neutral (no kind's table or module), and
// itself free of sibling modules (checked below), so the market can take it
// along if it is ever extracted.
const SHARED_ENGINE_DIRS = [path.join(MODULES_DIR, "catalog-overview")];

function isInside(dir: string, resolved: string) {
  return resolved === dir || resolved.startsWith(dir + path.sep);
}

/** Relative imports of files under `dir` that land in another module. */
function crossModuleImports(dir: string, allowed: string[]): string[] {
  const importRe = /from\s+["']([^"']+)["']/g;
  const violations: string[] = [];
  for (const file of tsFiles(dir)) {
    const source = readFileSync(file, "utf8");
    let match: RegExpExecArray | null;
    while ((match = importRe.exec(source)) !== null) {
      const spec = match[1];
      if (!spec || !spec.startsWith(".")) {
        continue; // packages + node builtins are fine
      }
      const resolved = path.resolve(path.dirname(file), spec);
      const insideModules = resolved.startsWith(MODULES_DIR + path.sep);
      if (
        insideModules &&
        !isInside(dir, resolved) &&
        !allowed.some((entry) => isInside(entry, resolved))
      ) {
        violations.push(`${path.relative(MODULES_DIR, file)} → ${spec}`);
      }
    }
  }
  return violations;
}

// Keep the market module self-contained so it can be extracted into an
// independent service later (the "operate the market independently" option)
// without unpicking couplings. It may depend on @sourceweft/db, contracts,
// ../../shared/* and the catalog overview engine, but never on another
// sibling backend module (mcp, workspace, threads, skills, …). If this fails,
// move the shared code into ../../shared or packages/* instead of reaching
// across modules.
test("market module does not import sibling backend modules", () => {
  const violations = crossModuleImports(MARKET_DIR, SHARED_ENGINE_DIRS);
  assert.deepEqual(
    violations,
    [],
    `market must stay self-contained; cross-module imports found:\n${violations.join("\n")}`,
  );
});

test("the catalog overview engine the market uses imports no backend module", () => {
  for (const dir of SHARED_ENGINE_DIRS) {
    const violations = crossModuleImports(dir, []);
    assert.deepEqual(
      violations,
      [],
      `${path.relative(MODULES_DIR, dir)} must stay kind-neutral; cross-module imports found:\n${violations.join("\n")}`,
    );
  }
});
