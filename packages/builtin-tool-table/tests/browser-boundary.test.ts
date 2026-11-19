import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The web bundles this package's `./export` and `./ui` subpaths. The generation
 * engine (and the root entry that exposes it to the backend) imports
 * `node:crypto`, so no runtime import reachable from those subpaths may lead to
 * it. Type-only imports are erased and do not count.
 *
 * `./ui` is added by a separate change; its entry is checked as soon as the file
 * exists and skipped while it does not.
 */

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(PACKAGE_ROOT, "src");
const SERVER_ONLY = [
  join(SRC, "engine") + "/",
  join(SRC, "capability.ts"),
  join(SRC, "index.ts"),
  join(SRC, "artifact-view.ts"),
];

function findEntry(...candidates: string[]) {
  return candidates.map((entry) => join(SRC, entry)).find((file) => existsSync(file)) ?? null;
}

const RUNTIME_IMPORT =
  /^\s*(?:import|export)\s+(?!type\b)(?:[^'"]*?\sfrom\s+)?["']([^"']+)["']/gm;

function resolveRelative(from: string, specifier: string) {
  const base = resolve(dirname(from), specifier);
  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
    base,
  ]) {
    if (existsSync(candidate)) {
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
        assert.ok(target, `${relative(PACKAGE_ROOT, file)} imports unresolved ${specifier}`);
        queue.push(target);
      } else {
        external.push({ from: file, specifier });
      }
    }
  }
  return { files: [...seen], external };
}

const ENTRIES: { label: string; file: string | null; required: boolean }[] = [
  { label: "./export", file: findEntry("export/index.ts"), required: true },
  { label: "./ui", file: findEntry("ui/index.tsx", "ui/index.ts"), required: false },
];

for (const { label, file, required } of ENTRIES) {
  test(`${label} never reaches server-only code`, (t) => {
    if (!file) {
      assert.ok(!required, `${label} entry is missing`);
      t.skip(`${label} does not exist in this branch yet`);
      return;
    }
    const { files, external } = reachable(file);
    assert.ok(files.length > 0);
    assert.deepEqual(
      files
        .filter((f) => SERVER_ONLY.some((prefix) => f === prefix || f.startsWith(prefix)))
        .map((f) => relative(PACKAGE_ROOT, f)),
      [],
    );
    assert.deepEqual(
      external
        .filter(
          ({ specifier }) =>
            specifier.startsWith("node:") ||
            specifier === "@sourceweft/builtin-tool-table" ||
            // The shared package's root entry is server-only; browsers use `/ui`.
            specifier === "@sourceweft/grounded-generation",
        )
        .map(({ from, specifier }) => `${relative(PACKAGE_ROOT, from)} → ${specifier}`),
      [],
    );
  });
}

test("the package exposes no subpath that leads straight to the engine", () => {
  const { exports } = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as {
    exports: Record<string, string>;
  };
  assert.deepEqual(
    Object.entries(exports)
      .filter(([, target]) => target.includes("/engine"))
      .map(([key]) => key),
    [],
  );
});
