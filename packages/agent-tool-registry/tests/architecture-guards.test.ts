import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { AGENT_TOOLS } from "../src/registry";

/**
 * Architecture guards for the two hand-written static tables in this package.
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
