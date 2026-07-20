import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import ts from "typescript";

/**
 * The hole `apps/backend/src/architecture-capability-imports.test.ts` cannot see.
 *
 * That guard stops a host file importing `@sourceweft/builtin-*`. But this
 * package is a *sanctioned* host dependency, and it exports `AGENT_TOOL_NAMES`
 * — a typed map from tool id to tool name, derived from `AGENT_TOOLS`. So
 * `AGENT_TOOL_NAMES.generateImage` gives a host file a fully typed,
 * autocompleted way to name one specific capability's tool, from an import the
 * other guard is happy to see. Same coupling, invisible to the same check.
 *
 * The distinction that matters is not "does the host name a tool" but "does it
 * name a *pluggable* one". The agent's baseline toolkit — the filesystem, the
 * sandbox, retrieval, web access — is infrastructure the host genuinely owns:
 * it implements those tools' backends, normalizes their outputs and decides
 * their permissions, and none of that is a feature that can be unplugged.
 * Naming `readFile` is the host talking about itself. Naming `generateImage` is
 * the host knowing a feature exists.
 *
 * WHY THIS LIVES HERE, not next to the backend guard: the offending export is
 * this package's, the data needed to classify a tool is already assembled in
 * this package's sibling guard (`architecture-guards.test.ts` reads each
 * capability's `*AgentToolDefs` the same way), and one file can scan both apps
 * at once — a copy per app would let the backend and web halves drift, and the
 * baseline-package list is exactly the kind of list that drifts.
 */

const PACKAGES_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO_ROOT = join(PACKAGES_ROOT, "..");
const REGISTRY_PACKAGE = "@sourceweft/agent-tool-registry";
const REGISTRY_EXPORT = "AGENT_TOOL_NAMES";

/**
 * The host source trees this guard covers.
 *
 * `apps/web/app` and `apps/web/lib` are in scope because the one production
 * violation this guard was written for lived in the composer, not the backend.
 * `apps/web/.next` is excluded because it is build output — generated files are
 * not authored code and the originals they came from are already scanned.
 */
const HOST_ROOTS = [
  join(REPO_ROOT, "apps", "backend", "src"),
  join(REPO_ROOT, "apps", "web", "app"),
  join(REPO_ROOT, "apps", "web", "lib"),
];

/**
 * Packages whose tools the host may name.
 *
 * These are the agent's baseline toolkit, not features: the host implements
 * their backends and owns their place in the turn, so a name crossing the
 * boundary carries no capability identity. Hardcoding *packages* rather than
 * tool names is deliberate — which tools a package ships is derived below, so
 * adding a filesystem tool needs no edit here, while adding a capability tool
 * is caught by default.
 *
 * The list overlaps but does not match the backend import guard's
 * INFRASTRUCTURE_PACKAGES, and cannot be shared with it: that guard is about
 * which packages the host may *import* (document-parsers, which ships no agent
 * tools, is on it), this one is about whose tools it may *name* (web-search,
 * which the host imports from nowhere, is on this one).
 */
const BASELINE_TOOLKIT_PACKAGES: readonly {
  readonly name: string;
  readonly reason: string;
}[] = [
  {
    name: "@sourceweft/builtin-vfs",
    reason:
      "The agent's filesystem. The host implements the store and backends these tools run against, and normalizes their outputs into working files, so it necessarily knows the tools by name.",
  },
  {
    name: "@sourceweft/builtin-tool-sandbox",
    reason:
      "The agent's execution sandbox. The host owns the sandbox session for the turn — provisioning, workspace preparation and output collection are host steps keyed to these tool names.",
  },
  {
    name: "@sourceweft/builtin-retrieval",
    reason:
      "The agent's access to the workspace's own sources. The host runs the retrieval planner and citation registry, both of which key off this tool.",
  },
  {
    name: "@sourceweft/builtin-tool-web-search",
    reason:
      "The agent's access to the open web. The host exposes it as a first-class composer toggle and a thread command, and attributes citations to it.",
  },
];

// ---------------------------------------------------------------------------
// Classification — derived, not hardcoded
// ---------------------------------------------------------------------------

type ToolOrigin = { readonly toolId: string; readonly packageName: string };

/**
 * Every tool id in `AGENT_TOOL_NAMES`, paired with the package that ships it.
 *
 * Read by importing each capability package's entry module and looking at its
 * `*AgentToolDefs` exports — the same technique, and the same reason, as the
 * sibling guard in `architecture-guards.test.ts`: reading exports off the real
 * module is exact where parsing source is guesswork. `AGENT_TOOL_NAMES` is
 * keyed by `id`, so `id` is what a host file writes and what is collected here.
 */
async function toolOrigins(): Promise<readonly ToolOrigin[]> {
  const origins: ToolOrigin[] = [];
  for (const entry of readdirSync(PACKAGES_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const dir = join(PACKAGES_ROOT, entry.name);
    const indexPath = join(dir, "src", "index.ts");
    const packageJsonPath = join(dir, "package.json");
    if (
      !existsSync(join(dir, "sourceweft.capability.json")) ||
      !existsSync(indexPath) ||
      !existsSync(packageJsonPath)
    ) {
      continue;
    }
    const packageName = (
      JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: string }
    ).name;
    if (!packageName) {
      continue;
    }
    const module = (await import(pathToFileURL(indexPath).href)) as Record<
      string,
      unknown
    >;
    for (const [exportName, value] of Object.entries(module)) {
      if (!exportName.endsWith("AgentToolDefs") || !Array.isArray(value)) {
        continue;
      }
      for (const def of value) {
        const toolId = (def as { id?: unknown }).id;
        if (typeof toolId === "string") {
          origins.push({ toolId, packageName });
        }
      }
    }
  }
  return origins;
}

function isBaselinePackage(packageName: string) {
  return BASELINE_TOOLKIT_PACKAGES.some((entry) => entry.name === packageName);
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

type Usage = { readonly toolId: string; readonly line: number };

/**
 * Local names `AGENT_TOOL_NAMES` was bound to in this file, if any.
 *
 * A set rather than a single name because the import may be aliased
 * (`AGENT_TOOL_NAMES as TOOLS`), and because a later `const X = TOOLS` rebinds
 * it again. Both are collected, so renaming the binding does not hide a use.
 */
function registryBindings(sourceFile: ts.SourceFile): Set<string> {
  const bindings = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      continue;
    }
    const specifier = statement.moduleSpecifier.text;
    if (
      specifier !== REGISTRY_PACKAGE &&
      !specifier.startsWith(`${REGISTRY_PACKAGE}/`)
    ) {
      continue;
    }
    const namedBindings = statement.importClause?.namedBindings;
    if (!namedBindings || !ts.isNamedImports(namedBindings)) {
      continue;
    }
    for (const element of namedBindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text;
      if (imported === REGISTRY_EXPORT) {
        bindings.add(element.name.text);
      }
    }
  }

  if (bindings.size === 0) {
    return bindings;
  }

  // Follow `const TOOLS = AGENT_TOOL_NAMES` re-bindings until nothing new is
  // found, so an alias chain cannot launder a property access out of view.
  let grew = true;
  while (grew) {
    grew = false;
    const visit = (node: ts.Node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isIdentifier(node.initializer) &&
        bindings.has(node.initializer.text) &&
        !bindings.has(node.name.text)
      ) {
        bindings.add(node.name.text);
        grew = true;
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sourceFile, visit);
  }

  return bindings;
}

/**
 * Every tool id this file names through `AGENT_TOOL_NAMES`.
 *
 * Three shapes reach a property, and all three are collected: dotted access
 * (`AGENT_TOOL_NAMES.generateImage`), indexed access with a literal
 * (`AGENT_TOOL_NAMES["generateImage"]`), and object destructuring
 * (`const { generateImage } = AGENT_TOOL_NAMES`, including
 * `{ generateImage: local }`). Computed indexing by a runtime value is *not*
 * collected and cannot be — but it also cannot name a capability at authoring
 * time, which is the thing being guarded against.
 */
function registryToolUsages(sourceFile: ts.SourceFile): Usage[] {
  const bindings = registryBindings(sourceFile);
  if (bindings.size === 0) {
    return [];
  }

  const usages: Usage[] = [];
  const lineOf = (node: ts.Node) =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      bindings.has(node.expression.text)
    ) {
      usages.push({ toolId: node.name.text, line: lineOf(node) });
    } else if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      bindings.has(node.expression.text) &&
      ts.isStringLiteralLike(node.argumentExpression)
    ) {
      usages.push({
        toolId: node.argumentExpression.text,
        line: lineOf(node),
      });
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      ts.isIdentifier(node.initializer) &&
      bindings.has(node.initializer.text)
    ) {
      for (const element of node.name.elements) {
        const property = element.propertyName ?? element.name;
        if (ts.isIdentifier(property) || ts.isStringLiteral(property)) {
          usages.push({ toolId: property.text, line: lineOf(element) });
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sourceFile, visit);
  return usages;
}

/**
 * Host files to scan.
 *
 * Test files are excluded on purpose. A test that exercises how the host treats
 * one capability has to name that capability to have a subject at all, and the
 * name never ships. The guard is about production code carrying the knowledge.
 */
function hostSourceFiles(): string[] {
  const files: string[] = [];
  const walk = (root: string) => {
    if (!existsSync(root)) {
      return;
    }
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".next") {
          continue;
        }
        walk(path);
      } else if (
        entry.isFile() &&
        (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
        !/\.(test|spec)\.tsx?$/.test(entry.name) &&
        !entry.name.endsWith(".d.ts")
      ) {
        files.push(path);
      }
    }
  };
  for (const root of HOST_ROOTS) {
    walk(root);
  }
  return files;
}

function parse(filePath: string) {
  return ts.createSourceFile(
    filePath,
    readFileSync(filePath, "utf8"),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function repoRelative(filePath: string) {
  return relative(REPO_ROOT, filePath).split(sep).join("/");
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

test("no host file names a capability's tool through AGENT_TOOL_NAMES", async () => {
  const origins = await toolOrigins();
  const capabilityToolIds = new Map<string, string>();
  for (const origin of origins) {
    if (!isBaselinePackage(origin.packageName)) {
      capabilityToolIds.set(origin.toolId, origin.packageName);
    }
  }

  // Without this the guard passes vacuously if the entry modules ever stop
  // exporting their defs — a green test that checks nothing is worse than none.
  assert.ok(
    capabilityToolIds.size > 0,
    "No capability tools were discovered, so this guard would pass no matter " +
      "what the host does. Something changed in how packages export " +
      "*AgentToolDefs; fix the derivation rather than deleting the guard.",
  );

  const offenders: string[] = [];
  for (const filePath of hostSourceFiles()) {
    for (const usage of registryToolUsages(parse(filePath))) {
      const owner = capabilityToolIds.get(usage.toolId);
      if (owner) {
        offenders.push(
          `${repoRelative(filePath)}:${usage.line} → AGENT_TOOL_NAMES.${usage.toolId} (${owner})`,
        );
      }
    }
  }

  assert.deepEqual(
    offenders.sort(),
    [],
    [
      "A host file names a capability's tool through AGENT_TOOL_NAMES:",
      ...offenders.map((offender) => `  - ${offender}`),
      "",
      "The registry is a sanctioned host dependency, so this import passes the",
      "capability-import guard — but the knowledge that crosses the boundary is",
      "the same. A branch on one capability's tool name is a branch the next",
      "capability has to come back and add itself to.",
      "",
      "Have the capability declare what the host needs to act on, and act on the",
      "declaration instead. The registry already carries several such channels:",
      "presentation, turnSelection, turnPreflight, artifactProgress, modelCatalog",
      "and an option's modelValues pointer. Ask the registry a question about the",
      "tool you are holding; do not ask whether it is a particular tool.",
      "",
      "Baseline toolkit tools — filesystem, sandbox, retrieval, web access — are",
      "allowed and are derived from their packages, not listed by name.",
    ].join("\n"),
  );
});

test("every baseline toolkit allowance is justified and still used", async () => {
  const origins = await toolOrigins();
  const named = new Set<string>();
  for (const filePath of hostSourceFiles()) {
    for (const usage of registryToolUsages(parse(filePath))) {
      named.add(usage.toolId);
    }
  }

  for (const entry of BASELINE_TOOLKIT_PACKAGES) {
    assert.ok(
      entry.reason.trim().length > 0,
      `Baseline allowance for ${entry.name} has no reason. An allowance without a stated reason is an unguarded hole.`,
    );

    const shipped = origins
      .filter((origin) => origin.packageName === entry.name)
      .map((origin) => origin.toolId);
    assert.ok(
      shipped.length > 0,
      `${entry.name} is allowed through the AGENT_TOOL_NAMES guard but ships no agent tools any more. Delete the allowance — an allowance for a package with no tools can only ever grow to cover tools nobody vetted.`,
    );
    assert.ok(
      shipped.some((toolId) => named.has(toolId)),
      `${entry.name} is allowed through the AGENT_TOOL_NAMES guard but no host file names any of its tools (${shipped.join(", ")}) any more. Delete the allowance so the package is guarded again.`,
    );
  }
});
