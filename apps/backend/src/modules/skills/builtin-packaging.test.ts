import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

/**
 * Builtin skill packages are discovered by scanning the packages directory
 * (see builtin.ts), never by importing them — their `src/index.ts` is a stub
 * and all the payload is SKILL.md plus references/.
 *
 * That makes them invisible to the dependency graph, and `turbo prune` in the
 * Dockerfile emits only the target packages and their workspace dependencies.
 * A skill package with no dependents is therefore dropped from the runtime
 * image, and builtin skill discovery silently finds nothing in production while
 * every local run and CI job stays green.
 *
 * Declaring them as backend dependencies is what keeps them in the pruned tree.
 * This guard fails the build when a new skill package is added without one.
 */

function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
      return dir;
    }
    dir = dirname(dir);
  }
  throw new Error("Could not locate repo root from builtin-packaging.test");
}

const REPO_ROOT = findRepoRoot();
const PACKAGES_ROOT = join(REPO_ROOT, "packages");

/** Packages whose capability manifest declares skill contributions. */
function skillPackageNames(): string[] {
  const names: string[] = [];
  for (const entry of readdirSync(PACKAGES_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const packageDir = join(PACKAGES_ROOT, entry.name);
    const manifestPath = join(packageDir, "sourceweft.capability.json");
    const packageJsonPath = join(packageDir, "package.json");
    if (!existsSync(manifestPath) || !existsSync(packageJsonPath)) {
      continue;
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      skills?: unknown[];
    };
    if (!Array.isArray(manifest.skills) || manifest.skills.length === 0) {
      continue;
    }
    const { name } = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      name?: string;
    };
    if (name) {
      names.push(name);
    }
  }
  return names.sort();
}

test("builtin skill packages are declared backend dependencies", () => {
  const { dependencies = {} } = JSON.parse(
    readFileSync(join(REPO_ROOT, "apps", "backend", "package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };

  const missing = skillPackageNames().filter(
    (name) => !(name in dependencies),
  );

  assert.deepEqual(
    missing,
    [],
    `These packages contribute builtin skills but are not dependencies of ` +
      `@sourceweft/backend. Undeclared workspace packages are dropped by ` +
      `\`turbo prune\`, so they will be missing from the runtime image and ` +
      `their skills will silently disappear in production: ${missing.join(", ")}`,
  );
});
