import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The web bundles this package's `./ui`, `./export` and `./testing` subpaths.
 * The generation engine (and the root entry that exposes it to the backend)
 * imports `node:crypto`, so no runtime import reachable from those subpaths
 * may lead to it. Type-only imports are erased and do not count.
 */

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(PACKAGE_ROOT, "src");
const BROWSER_ENTRIES = ["ui/index.tsx", "export/index.ts", "testing/index.ts"];
const SERVER_ONLY = [
  join(SRC, "engine") + "/",
  join(SRC, "scheduling") + "/",
  join(SRC, "capability.ts"),
  join(SRC, "index.ts"),
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
    if (existsSync(candidate) && !candidate.endsWith("/")) {
      try {
        readFileSync(candidate);
        return candidate;
      } catch {
        // a directory
      }
    }
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
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(RUNTIME_IMPORT)) {
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

for (const entry of BROWSER_ENTRIES) {
  test(`./${entry} never reaches server-only code`, () => {
    const { files, external } = reachable(join(SRC, entry));
    assert.ok(files.length > 0);
    const serverFiles = files.filter((file) =>
      SERVER_ONLY.some((prefix) => file === prefix || file.startsWith(prefix)),
    );
    assert.deepEqual(
      serverFiles.map((file) => relative(PACKAGE_ROOT, file)),
      [],
    );
    const nodeImports = external.filter(
      ({ specifier }) =>
        specifier.startsWith("node:") ||
        specifier === "ts-fsrs" ||
        specifier === "@sourceweft/builtin-tool-study" ||
        // The shared package's root entry is server-only; browsers use `/ui`.
        specifier === "@sourceweft/grounded-generation",
    );
    assert.deepEqual(
      nodeImports.map(({ from, specifier }) => `${relative(PACKAGE_ROOT, from)} → ${specifier}`),
      [],
    );
  });
}

test("the package exposes no subpath that leads straight to the engine or the scheduler", () => {
  const { exports } = JSON.parse(
    readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"),
  ) as { exports: Record<string, string> };
  assert.deepEqual(
    Object.entries(exports)
      .filter(([, target]) => target.includes("/engine") || target.includes("/scheduling"))
      .map(([key]) => key),
    [],
  );
});

test("only server-only files import ts-fsrs", () => {
  const { files, external } = reachable(join(SRC, "index.ts"));
  const users = external
    .filter(({ specifier }) => specifier === "ts-fsrs")
    .map(({ from }) => relative(PACKAGE_ROOT, from));
  assert.deepEqual(users, ["src/scheduling/fsrs.ts"]);
  assert.ok(files.some((file) => file.endsWith("scheduling/fsrs.ts")));
});
