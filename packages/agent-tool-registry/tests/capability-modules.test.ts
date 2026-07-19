import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { BUILTIN_CAPABILITY_MODULES } from "../src/capability-modules";

/**
 * Architecture guard for capability module bundling.
 *
 * A variable `import(packageName)` is not statically analyzable, so bundlers
 * leave it as a runtime import that resolves to the package's TS entry — which
 * a plain `node dist/…` process cannot load. The host catches that failure and
 * logs it at warn level, so the capability's tools silently disappear in
 * production while dev and test, both running through TS loaders, stay green.
 *
 * That class of bug is invisible to every other test in this repo. This guard
 * closes it structurally: every capability package exporting an entry factory
 * must appear in the static literal-import map.
 */

const PACKAGES_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

/** Factories a host loads off a capability entry module. */
const ENTRY_FACTORIES = [
  "createCapabilityAgentTools",
  "createDeliverablePipelines",
];

/**
 * Candidates are packages shipping a capability manifest — only those can
 * contribute a factory. Narrowing this way keeps the check to modules a host
 * would load anyway, and needs no source parsing: reading exports off the
 * imported module is exact, where a regex over TS source is not.
 */
function capabilityPackageEntries(): Array<{ name: string; indexPath: string }> {
  const entries: Array<{ name: string; indexPath: string }> = [];
  for (const entry of readdirSync(PACKAGES_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const packageDir = join(PACKAGES_ROOT, entry.name);
    const indexPath = join(packageDir, "src", "index.ts");
    const packageJsonPath = join(packageDir, "package.json");
    if (
      !existsSync(join(packageDir, "sourceweft.capability.json")) ||
      !existsSync(indexPath) ||
      !existsSync(packageJsonPath)
    ) {
      continue;
    }
    const { name } = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      name?: string;
    };
    if (name) {
      entries.push({ name, indexPath });
    }
  }
  return entries;
}

async function packagesExportingEntryFactory(): Promise<string[]> {
  const found: string[] = [];
  for (const { name, indexPath } of capabilityPackageEntries()) {
    const module = (await import(pathToFileURL(indexPath).href)) as Record<
      string,
      unknown
    >;
    if (ENTRY_FACTORIES.some((factory) => typeof module[factory] === "function")) {
      found.push(name);
    }
  }
  return found.sort();
}

test("every capability package exporting an entry factory is statically imported", async () => {
  const declared = Object.keys(BUILTIN_CAPABILITY_MODULES).sort();
  const actual = await packagesExportingEntryFactory();

  const missing = actual.filter((name) => !declared.includes(name));
  assert.deepEqual(
    missing,
    [],
    `These packages export an entry factory but are absent from ` +
      `BUILTIN_CAPABILITY_MODULES. Without a static literal import a bundler ` +
      `cannot include them, and their tools/pipelines silently vanish in ` +
      `production: ${missing.join(", ")}`,
  );

  const stale = declared.filter((name) => !actual.includes(name));
  assert.deepEqual(
    stale,
    [],
    `These packages are listed in BUILTIN_CAPABILITY_MODULES but no longer ` +
      `export an entry factory: ${stale.join(", ")}`,
  );
});

test("mapped packages are declared dependencies of this registry", () => {
  const { dependencies = {} } = JSON.parse(
    readFileSync(join(PACKAGES_ROOT, "agent-tool-registry", "package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };

  for (const packageName of Object.keys(BUILTIN_CAPABILITY_MODULES)) {
    assert.ok(
      packageName in dependencies,
      `${packageName} is in BUILTIN_CAPABILITY_MODULES but not a dependency ` +
        `of @sourceweft/agent-tool-registry. Undeclared workspace packages are ` +
        `dropped by \`turbo prune\` and will be missing from the runtime image.`,
    );
  }
});

test("static imports use literal specifiers", () => {
  const source = readFileSync(
    join(PACKAGES_ROOT, "agent-tool-registry", "src", "capability-modules.ts"),
    "utf8",
  );
  for (const packageName of Object.keys(BUILTIN_CAPABILITY_MODULES)) {
    assert.ok(
      source.includes(`import("${packageName}")`),
      `BUILTIN_CAPABILITY_MODULES must import "${packageName}" with a literal ` +
        `specifier so bundlers can include it.`,
    );
  }
});
