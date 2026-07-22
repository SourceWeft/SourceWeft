import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { AGENT_TOOLS } from "../src/registry";

/**
 * Architecture guards for this package's hand-written static tables, and for
 * the entry boundary that decides which of them a given host can see.
 *
 * `capability-modules.test.ts` guards `BUILTIN_CAPABILITY_MODULES` against a
 * failure mode that no other test in the repo can see: a capability that is
 * built, exported and type-correct, yet never reaches the host, so the feature
 * silently degrades in production while every test stays green.
 *
 * The same reasoning applies verbatim to `AGENT_TOOLS` (registry.ts) and
 * `ARTIFACT_UI_MODULES` (ui.ts). Both are hand-maintained lists of imports and
 * spreads; forgetting a line in either compiles, type-checks and passes every
 * existing test, while the capability quietly loses its presentation or its
 * entire UI. These two guards close both holes structurally.
 *
 * Guard 3 is about the third table by another name: the package's `exports`
 * map. Its failure mode is louder but no more local — see the guard.
 */

const PACKAGES_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const REGISTRY_ROOT = join(PACKAGES_ROOT, "agent-tool-registry");

type CapabilityPackage = {
  /** npm name, e.g. `@sourceweft/builtin-tool-generate-image`. */
  name: string;
  dir: string;
  indexPath: string;
  /** `kind` from sourceweft.capability.json. */
  kind: string;
  packageJson: { exports?: Record<string, unknown> };
};

/**
 * Candidates are packages shipping a capability manifest — same narrowing as
 * `capability-modules.test.ts`, for the same reason: only those can contribute
 * to a host registry at all.
 */
function capabilityPackages(): CapabilityPackage[] {
  const packages: CapabilityPackage[] = [];
  for (const entry of readdirSync(PACKAGES_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const dir = join(PACKAGES_ROOT, entry.name);
    const manifestPath = join(dir, "sourceweft.capability.json");
    const packageJsonPath = join(dir, "package.json");
    const indexPath = join(dir, "src", "index.ts");
    if (
      !existsSync(manifestPath) ||
      !existsSync(packageJsonPath) ||
      !existsSync(indexPath)
    ) {
      continue;
    }
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      name?: string;
      exports?: Record<string, unknown>;
    };
    const { kind } = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      kind?: string;
    };
    if (packageJson.name) {
      packages.push({
        name: packageJson.name,
        dir,
        indexPath,
        kind: kind ?? "",
        packageJson,
      });
    }
  }
  return packages.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Guard 1 — AGENT_TOOLS (src/registry.ts)
// ---------------------------------------------------------------------------

/**
 * Connector capabilities are the one deliberate exception. Their tools are
 * bound to a per-workspace connector instance, so hosts feed them in through
 * `registerAgentTools()` at boot (see
 * apps/backend/src/modules/connectors/register-builtin-adapters.ts) rather than
 * baking them into the static table. Excluding them by manifest `kind` keeps
 * that carve-out declarative instead of a hardcoded package allowlist.
 */
const RUNTIME_REGISTERED_KINDS = new Set(["connector"]);

/**
 * Read the tool names a package publishes through its `*AgentToolDefs` exports.
 *
 * Same technique as the existing guard: import the real entry module and read
 * the exports off it, because reading exports off the imported module is exact,
 * where a regex over TS source is not.
 */
async function exportedAgentToolNames(
  indexPath: string,
): Promise<{ exportName: string; toolNames: string[] }[]> {
  const module = (await import(pathToFileURL(indexPath).href)) as Record<
    string,
    unknown
  >;
  const found: { exportName: string; toolNames: string[] }[] = [];
  for (const [exportName, value] of Object.entries(module)) {
    if (!exportName.endsWith("AgentToolDefs") || !Array.isArray(value)) {
      continue;
    }
    const toolNames = value
      .map((def) => (def as { name?: unknown }).name)
      .filter((name): name is string => typeof name === "string");
    found.push({ exportName, toolNames });
  }
  return found;
}

test("every capability package exporting agent tool defs is spread into AGENT_TOOLS", async () => {
  // Widened to string: the guard's whole point is to test names that are NOT
  // in the union, so keeping the literal type here would make the lookup a
  // compile error instead of the assertion it is meant to be.
  const registered = new Set<string>(AGENT_TOOLS.map((tool) => tool.name));

  const missing: string[] = [];
  const exportedNames = new Set<string>();

  for (const pkg of capabilityPackages()) {
    if (RUNTIME_REGISTERED_KINDS.has(pkg.kind)) {
      continue;
    }
    for (const { exportName, toolNames } of await exportedAgentToolNames(
      pkg.indexPath,
    )) {
      for (const toolName of toolNames) {
        exportedNames.add(toolName);
        if (!registered.has(toolName)) {
          missing.push(`${pkg.name} → ${exportName} → "${toolName}"`);
        }
      }
    }
  }

  assert.deepEqual(
    missing,
    [],
    `These agent tool definitions are exported by a capability package but are ` +
      `absent from AGENT_TOOLS in src/registry.ts. A tool missing from that ` +
      `table is invisible to getAgentToolDefinition, so ` +
      `getAgentToolPresentation, getArtifactProgressProtocol and ` +
      `getAgentToolRenderAs all return null: the capability silently degrades ` +
      `to a bare tool card with no artifact block, no progress reporting and ` +
      `no custom copy, and nothing else in this repo fails. ` +
      `Missing: ${missing.join(", ")}`,
  );

  const stale = AGENT_TOOLS.map((tool) => tool.name)
    .filter((name) => !exportedNames.has(name))
    .sort();

  assert.deepEqual(
    stale,
    [],
    `These tools are spread into AGENT_TOOLS but no capability package exports ` +
      `them through a "*AgentToolDefs" export any more. The table is stale and ` +
      `is advertising tools their owning capability no longer ships: ` +
      `${stale.join(", ")}`,
  );
});

// ---------------------------------------------------------------------------
// Guard 2 — ARTIFACT_UI_MODULES (src/ui.ts)
// ---------------------------------------------------------------------------

/**
 * Deliberate deviation from the "import the real module" technique used above.
 *
 * `src/ui.ts` is the package's React subpath — importing it pulls in the
 * capability packages' `.tsx` UI trees and React itself, which the node test
 * runner (plain `tsx --test`, no DOM, no JSX runtime configured for this
 * package's tests) cannot load. Importing it would make this guard fail for
 * environment reasons rather than architecture reasons, which is worse than no
 * guard at all.
 *
 * So this guard reads the table from source instead. It stays exact enough for
 * its purpose because it does not try to understand TypeScript: it only needs
 * (a) which identifiers sit inside the ARTIFACT_UI_MODULES array literal and
 * (b) which module specifier each of those identifiers was imported from. Both
 * are single-line, machine-written shapes in this file. Notably it must ignore
 * the unrelated `.../ui` re-exports at the bottom of ui.ts — checking that a
 * package is merely *imported* would pass while the package is still absent
 * from the array, so membership is resolved through the array literal itself.
 */
function packagesListedInArtifactUiModules(): string[] {
  const source = readFileSync(join(REGISTRY_ROOT, "src", "ui.ts"), "utf8");

  const importedFrom = new Map<string, string>();
  const importPattern = /import\s*\{([^}]*)\}\s*from\s*"([^"]+)"/g;
  for (const match of source.matchAll(importPattern)) {
    const [, clause, specifier] = match;
    if (!clause || !specifier) {
      continue;
    }
    for (const binding of clause.split(",")) {
      const local = binding.trim().split(/\s+as\s+/).pop()?.trim();
      if (local) {
        importedFrom.set(local, specifier);
      }
    }
  }

  const arrayMatch =
    /export\s+const\s+ARTIFACT_UI_MODULES[^=]*=\s*\[([^\]]*)\]/.exec(source);
  assert.ok(
    arrayMatch,
    `Could not locate the ARTIFACT_UI_MODULES array literal in src/ui.ts. ` +
      `This guard reads that table from source; if its shape changed, update ` +
      `the guard rather than deleting it.`,
  );

  const listed = new Set<string>();
  for (const rawEntry of (arrayMatch[1] ?? "").split(",")) {
    const identifier = rawEntry.trim();
    if (!identifier) {
      continue;
    }
    const specifier = importedFrom.get(identifier);
    if (specifier) {
      listed.add(specifier.replace(/\/ui$/, ""));
    }
  }
  return [...listed].sort();
}

test("every capability package with a \"./ui\" export is listed in ARTIFACT_UI_MODULES", () => {
  const declared = packagesListedInArtifactUiModules();

  const actual = capabilityPackages()
    .filter((pkg) => Boolean(pkg.packageJson.exports?.["./ui"]))
    .map((pkg) => pkg.name)
    .sort();

  const missing = actual.filter((name) => !declared.includes(name));
  assert.deepEqual(
    missing,
    [],
    `These capability packages ship a "./ui" subpath export but are absent ` +
      `from ARTIFACT_UI_MODULES in src/ui.ts. That table is the only way the ` +
      `app reaches a capability's UI, so both of its surfaces disappear at ` +
      `once and silently: resolveArtifactBlock returns null, so the artifact ` +
      `block vanishes from the message stream, and resolveArtifactPreview ` +
      `returns null, so the preview panel has nothing to render for the ` +
      `artifact. Nothing throws and no other test notices. ` +
      `Missing: ${missing.join(", ")}`,
  );

  const stale = declared.filter((name) => !actual.includes(name));
  assert.deepEqual(
    stale,
    [],
    `These packages are listed in ARTIFACT_UI_MODULES but no longer declare a ` +
      `"./ui" export in their package.json, so the import cannot resolve: ` +
      `${stale.join(", ")}`,
  );
});

// ---------------------------------------------------------------------------
// Guard 3 — the main entry stays out of the server-only graph (src/server.ts)
// ---------------------------------------------------------------------------

/**
 * The package has three entries with three audiences: `.` is isomorphic, `./ui`
 * is the browser's, `./server` is the node-only one. Only the first is imported
 * by both hosts, so only the first has to be kept honest by a test.
 *
 * The failure this catches is a build break, not a silent degradation — but a
 * remote one. `./server` reaches capability entry modules, and one of those
 * (the Daytona sandbox provider) transitively requires `async_hooks`. Re-export
 * it from `src/index.ts` and every client component that imports this package
 * for a tool name drags that graph into the browser bundle, and the app's own
 * pages start failing to compile with a module-not-found error naming a package
 * nobody touched. Being lazy does not help: a bundler must still emit the chunk
 * behind an `import()`, so it still resolves the node-only graph.
 *
 * Relative imports are followed transitively, because the offending re-export
 * is as likely to be added one module deep as in the index itself.
 */
function relativeImportsFrom(filePath: string): string[] {
  const source = readFileSync(filePath, "utf8");
  const specifiers: string[] = [];
  const pattern = /(?:^|\s)(?:import|export)[\s\S]*?from\s*"(\.[^"]*)"/g;
  for (const match of source.matchAll(pattern)) {
    if (match[1]) {
      specifiers.push(match[1]);
    }
  }
  return specifiers;
}

function resolveLocalModule(fromFile: string, specifier: string): string | null {
  const base = join(dirname(fromFile), specifier);
  // Extensions first, then the directory form: `existsSync(base)` is true for a
  // directory too, so probing it bare would resolve `./foo` to the folder.
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** Every module reachable from `entry` through relative imports, entry included. */
function localModuleGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const current = queue.pop();
    if (!current || seen.has(current)) {
      continue;
    }
    seen.add(current);
    for (const specifier of relativeImportsFrom(current)) {
      const resolved = resolveLocalModule(current, specifier);
      if (resolved) {
        queue.push(resolved);
      }
    }
  }
  return seen;
}

test("the main entry does not reach the server-only modules", () => {
  const srcDir = join(REGISTRY_ROOT, "src");
  const serverOnly = localModuleGraph(join(srcDir, "server.ts"));
  serverOnly.delete(join(srcDir, "server.ts"));

  const leaked = [...localModuleGraph(join(srcDir, "index.ts"))]
    .filter((module) => serverOnly.has(module))
    .map((module) => `src/${module.slice(srcDir.length + 1)}`)
    .sort();

  assert.deepEqual(
    leaked,
    [],
    `These modules are reachable from BOTH src/index.ts and src/server.ts. ` +
      `src/index.ts is imported by the web app's client components; ` +
      `src/server.ts reaches capability entry modules whose graph is ` +
      `node-only (the Daytona provider pulls in the OpenTelemetry node SDK, ` +
      `which requires "async_hooks"). Sharing a module between the two puts ` +
      `that graph in the browser bundle and breaks the app build with a ` +
      `module-not-found error naming a package nobody edited. A lazy ` +
      `import() does not help — the bundler still has to resolve the chunk. ` +
      `Import from "@sourceweft/agent-tool-registry/server" instead: ` +
      `${leaked.join(", ")}`,
  );
});
