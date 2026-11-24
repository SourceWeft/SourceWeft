import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The web bundles this package's `./ui` subpath. Corpus assembly and
 * anchoring (and the root entry that exposes them to the backend) import
 * `node:crypto`, so no runtime import reachable from `./ui` may lead to them.
 * Type-only imports are erased and do not count.
 */

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(PACKAGE_ROOT, "src");
const BROWSER_ENTRIES = ["ui/index.ts", "public-evidence.ts"];
const SERVER_ONLY = [
  join(SRC, "corpus.ts"),
  join(SRC, "anchoring.ts"),
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
    const serverFiles = files.filter((file) => SERVER_ONLY.includes(file));
    assert.deepEqual(
      serverFiles.map((file) => relative(PACKAGE_ROOT, file)),
      [],
    );
    const nodeImports = external.filter(
      ({ specifier }) =>
        specifier.startsWith("node:") ||
        specifier === "@sourceweft/grounded-generation",
    );
    assert.deepEqual(
      nodeImports.map(({ from, specifier }) => `${relative(PACKAGE_ROOT, from)} → ${specifier}`),
      [],
    );
  });
}

test("the package exposes only the server entry and the browser entries", () => {
  const { exports } = JSON.parse(
    readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"),
  ) as { exports: Record<string, string> };
  assert.deepEqual(exports, {
    ".": "./src/index.ts",
    "./ui": "./src/ui/index.ts",
    // Pure, React-free: public-share stripping and its placeholder.
    "./public-evidence": "./src/public-evidence.ts",
  });
});

test("only server-only files import node built-ins", () => {
  const { external } = reachable(join(SRC, "index.ts"));
  const users = external
    .filter(({ specifier }) => specifier.startsWith("node:"))
    .map(({ from }) => relative(PACKAGE_ROOT, from));
  assert.deepEqual(users, ["src/anchoring.ts"]);
});
