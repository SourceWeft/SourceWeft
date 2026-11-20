import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The web bundles `./ui`. The generation engine and the root entry that
 * exposes it to the backend import Node-only modules, so no runtime import
 * reachable from the browser entry may lead to them. Type-only imports are
 * erased and do not count.
 */

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(PACKAGE_ROOT, "src");
const BROWSER_ENTRY = join(SRC, "ui", "index.tsx");
const SERVER_ONLY = [
  join(SRC, "engine") + "/",
  join(SRC, "capability.ts"),
  join(SRC, "index.ts"),
];
const SERVER_PACKAGES = [
  "@sourceweft/builtin-tool-table",
  // The shared package's root entry is server-only; browsers use `/ui`.
  "@sourceweft/grounded-generation",
  "@sourceweft/model-gateway",
];

const RUNTIME_IMPORT =
  /^\s*(?:import|export)\s+(?!type\b)(?:[^'"]*?\sfrom\s+)?["']([^"']+)["']/gm;

function resolveRelative(from: string, specifier: string) {
  const base = resolve(dirname(from), specifier);
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function reachable(entry: string) {
  const seen = new Set<string>();
  const external: { from: string; specifier: string }[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const match of readFileSync(file, "utf8").matchAll(RUNTIME_IMPORT)) {
      const specifier = match[1]!;
      if (specifier.startsWith(".")) {
        const target = resolveRelative(file, specifier);
        if (target) queue.push(target);
      } else {
        external.push({ from: file, specifier });
      }
    }
  }
  return { files: [...seen], external };
}

test("./ui never reaches server-only code", () => {
  const { files, external } = reachable(BROWSER_ENTRY);
  assert.ok(files.length > 3, "the entry should reach the viewer files");
  assert.deepEqual(
    files
      .filter((file) => SERVER_ONLY.some((prefix) => file === prefix || file.startsWith(prefix)))
      .map((file) => relative(PACKAGE_ROOT, file)),
    [],
  );
  assert.deepEqual(
    external
      .filter(
        ({ specifier }) =>
          specifier.startsWith("node:") || SERVER_PACKAGES.includes(specifier),
      )
      .map(({ from, specifier }) => `${relative(PACKAGE_ROOT, from)} → ${specifier}`),
    [],
  );
});

// Both are browser entries the shared package's own boundary test keeps clean.
const BROWSER_SAFE_SHARED = [
  "@sourceweft/grounded-generation/ui",
  "@sourceweft/grounded-generation/public-evidence",
];

test("./ui reaches the shared package only through its browser subpaths", () => {
  const { external } = reachable(BROWSER_ENTRY);
  const shared = external
    .map(({ specifier }) => specifier)
    .filter((specifier) => specifier.startsWith("@sourceweft/grounded-generation"));
  assert.ok(shared.length > 0);
  assert.deepEqual(
    shared.filter((specifier) => !BROWSER_SAFE_SHARED.includes(specifier)),
    [],
  );
});

test("the package exposes no subpath that leads straight to the engine", () => {
  const { exports } = JSON.parse(
    readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"),
  ) as { exports: Record<string, string> };
  assert.deepEqual(
    Object.entries(exports)
      .filter(([, target]) => target.includes("/engine"))
      .map(([key]) => key),
    [],
  );
});
