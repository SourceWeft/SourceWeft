import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import ts from "typescript";

/**
 * The host↔capability import boundary, for the whole backend.
 *
 * `apps/backend/src` is meant to be a substrate that knows nothing about which
 * capabilities exist. It reaches capabilities through two — and only two —
 * seams: shared contracts in `@sourceweft/contracts` /
 * `@sourceweft/capability-contracts`, and the static module table in
 * `@sourceweft/agent-tool-registry`. Everything else a capability offers
 * arrives through its manifest at runtime.
 *
 * An import of a capability package breaks that quietly. Nothing fails; the
 * host simply stops being substrate, and the proof — "delete a capability
 * package and the host still builds" — stops holding. By the time anyone
 * notices, the import is load-bearing.
 *
 * The TypeScript parser is used rather than a regex on purpose. `import { type
 * Foo, bar } from "…"` and `import type { Foo } from "…"` are different nodes
 * with the same-looking text; a re-export (`export … from`), a bare side-effect
 * import, and a dynamic `import()` are three more shapes a specifier can hide
 * in. All five are collected below.
 *
 * Sibling guards, narrower in scope: `modules/threads/agent/capability-tools/
 * architecture.test.ts` (the shape of the tool contract, not its imports),
 * `shared/model-gateway/architecture.test.ts`,
 * `packages/agent-tool-registry/tests/architecture-guards.test.ts`.
 */

const SRC_ROOT = dirname(fileURLToPath(import.meta.url));
const PACKAGES_ROOT = join(SRC_ROOT, "..", "..", "..", "packages");

/**
 * What counts as a capability package.
 *
 * Naming alone is not enough. `@sourceweft/builtin-*` catches the packages that
 * happen to follow the convention, but a capability is defined by shipping a
 * `sourceweft.capability.json` — and the packages that do not follow the
 * convention are exactly the ones a prefix rule would wave through.
 * `@sourceweft/sandbox-provider-daytona` was imported directly by the sandbox
 * provider registry for as long as this guard existed and was never flagged,
 * because a vendor-named package does not start with `builtin-`.
 *
 * So the set is read from the workspace: any package with a manifest, plus the
 * prefix as a belt-and-braces rule for a package that is being built and has
 * not written its manifest yet.
 */
const CAPABILITY_PACKAGE_PREFIX = "@sourceweft/builtin-";

function manifestBearingPackageNames(): readonly string[] {
  const names: string[] = [];
  for (const entry of readdirSync(PACKAGES_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const packageDir = join(PACKAGES_ROOT, entry.name);
    if (!existsSync(join(packageDir, "sourceweft.capability.json"))) {
      continue;
    }
    const packageJsonPath = join(packageDir, "package.json");
    if (!existsSync(packageJsonPath)) {
      continue;
    }
    const { name } = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      name?: string;
    };
    if (name) {
      names.push(name);
    }
  }
  return names;
}

const CAPABILITY_PACKAGE_NAMES = manifestBearingPackageNames();

function isCapabilitySpecifier(specifier: string) {
  return (
    specifier.startsWith(CAPABILITY_PACKAGE_PREFIX) ||
    CAPABILITY_PACKAGE_NAMES.some((name) => isPackage(specifier, name))
  );
}

/**
 * Packages that are named `builtin-*` but are host infrastructure, not
 * capabilities: the host depends on their *ports and base classes*, the way it
 * depends on any shared library, and no capability identity crosses the
 * boundary when it does.
 *
 * They keep the `builtin-` prefix only because they have not been renamed yet.
 * When they are, these entries should disappear rather than be re-justified —
 * which is what the "still imported" self-check below forces.
 */
const INFRASTRUCTURE_PACKAGES: readonly {
  readonly name: string;
  readonly reason: string;
}[] = [
  {
    name: "@sourceweft/builtin-vfs",
    reason:
      "Virtual filesystem ports and the backend's own store/backend base classes. The host implements these interfaces; it does not consume a capability through them.",
  },
  {
    name: "@sourceweft/builtin-tool-sandbox",
    reason:
      "Sandbox runtime ports and provider base classes. The host owns sandbox sessions for the turn and implements the provider registry against these types.",
  },
  {
    name: "@sourceweft/builtin-document-parsers",
    reason:
      "Source-ingestion parser base classes and MIME constants. Parsing is a host pipeline; the package supplies the shared parser shapes it is built from.",
  },
  {
    name: "@sourceweft/builtin-retrieval",
    reason:
      "Retrieval ports and chunking primitives used by the host's own retrieval planner and citation registry.",
  },
];

/**
 * Directories held to the stricter rule: inside them the
 * `INFRASTRUCTURE_PACKAGES` allowance does not apply, so *any* `builtin-*`
 * specifier is an offence and has to be justified file by file below.
 *
 * The allowance exists because most of the host legitimately builds on those
 * packages' ports. A few places have a stronger claim than that — code whose
 * whole purpose is to be capability-blind, where even "we only use its base
 * class" is a coupling worth spelling out. Listing the directory here is how
 * that stronger claim is stated once instead of being re-argued per review.
 */
const INFRASTRUCTURE_STRICT_DIRECTORIES: readonly {
  readonly directory: string;
  readonly reason: string;
}[] = [
  {
    directory: "modules/threads/agent/capability-tools",
    reason:
      "The host's capability tool binder: a module whose entire job is to bind tools it knows nothing about. If it may reach for infrastructure ports freely, the one import that is really a capability's own type arrives looking exactly like the rest. Every builtin-* specifier here is listed in FILE_EXEMPTIONS with its own reason.",
  },
];

/**
 * Files allowed to import a capability package, each with the reason the
 * general rule does not apply. Every entry is a debt, and the self-check below
 * fails the moment one stops being needed.
 */
const FILE_EXEMPTIONS: readonly {
  readonly file: string;
  readonly reason: string;
}[] = [
  {
    file: "scripts/smoke-video-presentation-job.ts",
    reason:
      "Developer smoke harness, not runtime. It is not reachable from any of the three bundled entrypoints (see tsup.config.ts: api, worker, scheduler), so nothing it imports ships. Its entire purpose is to drive one capability end to end through the host's queue and database, so a capability-agnostic version of it could not do its job; and moving it into the owning package would force that package to depend on @sourceweft/db and bullmq — the host's database and queue — which is a strictly worse coupling than a script naming a package.",
  },
  {
    file: "worker/deliverable-host/video-presentation-pipeline.integration.test.ts",
    reason:
      "Genuine integration test. Its subject is the seam itself: the host's generic deliverable processor driving a real pipeline definition end to end. Replacing the pipeline with a synthetic one would leave a test that asserts the host talks to itself. It cannot move into the capability package either, because the other half — the processor — is host code.",
  },
  {
    file: "modules/threads/agent/capability-tools/types.ts",
    // TODO(capability-boundary): the sandbox runtime a turn holds is host
    // state; move `AgentSandboxRuntimeForTurn`'s shape into
    // `@sourceweft/contracts` (as `AgentToolSandboxRuntime`) and have the
    // sandbox package alias it, the way the web provider port was moved.
    reason:
      "Type-imports AgentSandboxRuntimeForTurn from @sourceweft/builtin-tool-sandbox to type the turn input. That package is infrastructure, so this would pass anywhere else in the host; it is called out only because capability-tools is an INFRASTRUCTURE_STRICT_DIRECTORIES entry. Pre-dates that module; the sandbox runtime is threaded through turn assembly, which is not this refactor's to move.",
  },
  {
    file: "worker/deliverable-host/video-stage-runner.test.ts",
    reason:
      "Genuine integration test, same seam as above: the host's generic stage runner bound to a real pipeline's stage list and progress function. What is being checked is that the host's runner behaves correctly against a pipeline it did not author.",
  },
  {
    file: "shared/sandbox-assets/catalog.ts",
    reason:
      "The runtime-asset catalog (docs/architecture/sandbox-runtime-assets.md, A3): a feature declares its asset spec beside the dependency pin that makes the version correct — chrome-headless-shell's version and sha live next to the @remotion/renderer pin in the video package — and this file only assembles the lookup table. Importing the spec value is the price of keeping spec and pin adjacent; moving it into contracts would separate them, and the catalog stays a plain data table either way.",
  },
];

/**
 * Parsed once per file, shared by every test below. Four tests each walking the
 * whole backend with a fresh parse is the same work four times over, and it is
 * enough of it to run into the default test timeout.
 */
const parseCache = new Map<string, ts.SourceFile>();

function parse(filePath: string) {
  const cached = parseCache.get(filePath);
  if (cached) {
    return cached;
  }
  const sourceFile = ts.createSourceFile(
    filePath,
    readFileSync(filePath, "utf8"),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
  parseCache.set(filePath, sourceFile);
  return sourceFile;
}

type Reference = { readonly specifier: string; readonly line: number };

/**
 * Every module specifier in a file, from all five syntactic shapes a specifier
 * can take. Missing one is how a guard like this becomes decorative.
 */
function moduleReferences(sourceFile: ts.SourceFile): Reference[] {
  const references: Reference[] = [];

  const record = (node: ts.Node, specifier: ts.Expression | undefined) => {
    if (!specifier || !ts.isStringLiteralLike(specifier)) {
      return;
    }
    references.push({
      specifier: specifier.text,
      line:
        sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
          .line + 1,
    });
  };

  const visit = (node: ts.Node) => {
    // `import x from "…"`, `import type {…} from "…"`, `import "…"`
    if (ts.isImportDeclaration(node)) {
      record(node, node.moduleSpecifier);
    }
    // `export {…} from "…"`, `export * from "…"`
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      record(node, node.moduleSpecifier);
    }
    // `import x = require("…")`
    else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      record(node, node.moduleReference.expression);
    }
    // `await import("…")`
    else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      record(node, node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sourceFile, visit);
  return references;
}

function typeScriptFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...typeScriptFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
}

function relativeToSrc(filePath: string) {
  return relative(SRC_ROOT, filePath).split(sep).join("/");
}

/** True for `@sourceweft/builtin-x` and `@sourceweft/builtin-x/deep/path`. */
function isPackage(specifier: string, packageName: string) {
  return specifier === packageName || specifier.startsWith(`${packageName}/`);
}

function isInfrastructure(specifier: string) {
  return INFRASTRUCTURE_PACKAGES.some((entry) =>
    isPackage(specifier, entry.name),
  );
}

/** True for a file inside a directory that forfeits the infrastructure allowance. */
function isInStrictDirectory(relativePath: string) {
  return INFRASTRUCTURE_STRICT_DIRECTORIES.some(
    (entry) =>
      relativePath === entry.directory ||
      relativePath.startsWith(`${entry.directory}/`),
  );
}

/**
 * The offending specifiers in one file. `relativePath` is not cosmetic: it
 * decides whether the infrastructure allowance applies at all.
 */
function capabilityReferences(
  filePath: string,
  relativePath: string,
): Reference[] {
  const infrastructureAllowed = !isInStrictDirectory(relativePath);
  return moduleReferences(parse(filePath)).filter(
    (reference) =>
      isCapabilitySpecifier(reference.specifier) &&
      !(infrastructureAllowed && isInfrastructure(reference.specifier)),
  );
}

test("apps/backend/src imports no capability package", () => {
  const exempt = new Set(FILE_EXEMPTIONS.map((entry) => entry.file));
  const offenders: string[] = [];

  for (const filePath of typeScriptFiles(SRC_ROOT)) {
    const relativePath = relativeToSrc(filePath);
    if (exempt.has(relativePath)) {
      continue;
    }
    for (const reference of capabilityReferences(filePath, relativePath)) {
      offenders.push(
        `src/${relativePath}:${reference.line} → ${reference.specifier}`,
      );
    }
  }

  assert.deepEqual(
    offenders.sort(),
    [],
    [
      "apps/backend/src imports a capability package:",
      ...offenders.map((offender) => `  - ${offender}`),
      "",
      "The backend is generic substrate. It must not know which capabilities",
      "exist — not their package names, tool names, skill ids, artifact types,",
      "job names or event names. Once it does, removing or replacing a",
      "capability breaks the host's build instead of simply removing a feature.",
      "",
      "Reach for one of the two seams instead:",
      "  - @sourceweft/contracts / @sourceweft/capability-contracts for shapes",
      "    shared between host and capability (declare the shape there and have",
      "    the capability alias it, as the web provider port does);",
      "  - @sourceweft/agent-tool-registry for the static module table, when the",
      "    host has to load a capability's entry module at all.",
      "",
      "Some builtin-* packages are host infrastructure and are allowed",
      "(INFRASTRUCTURE_PACKAGES) — but not everywhere: inside an",
      "INFRASTRUCTURE_STRICT_DIRECTORIES entry, even those are offences,",
      "because that code's whole point is to be capability-blind.",
      "",
      "In a test, the fixture you want is almost certainly",
      "src/test/synthetic-capability.ts. Binding a real capability makes a host",
      "test fail for reasons that have nothing to do with the host. If the test",
      "is genuinely about a real capability's behaviour, it belongs in that",
      "capability's package.",
    ].join("\n"),
  );
});

test("capability detection is not just the builtin- naming convention", () => {
  assert.ok(
    CAPABILITY_PACKAGE_NAMES.length > 0,
    "No package in packages/ ships a sourceweft.capability.json, so the guard " +
      "is running on the naming convention alone. Either the packages root is " +
      "resolving to the wrong directory, or manifests have moved.",
  );
  assert.ok(
    CAPABILITY_PACKAGE_NAMES.some(
      (name) => !name.startsWith(CAPABILITY_PACKAGE_PREFIX),
    ),
    "Every capability package currently happens to be named `builtin-*`, so " +
      "the manifest-based half of the rule cannot be observed to work. Keep " +
      "it anyway — the packages it exists for are precisely the ones that do " +
      "not follow the convention — but check it is still reading manifests.",
  );
});

test("every infrastructure package allowance is still used", () => {
  const specifiers = new Set<string>();
  for (const filePath of typeScriptFiles(SRC_ROOT)) {
    // Imports inside a strict directory are not covered by the allowance, so
    // they cannot be what keeps it alive.
    if (isInStrictDirectory(relativeToSrc(filePath))) {
      continue;
    }
    for (const reference of moduleReferences(parse(filePath))) {
      if (isCapabilitySpecifier(reference.specifier)) {
        specifiers.add(reference.specifier);
      }
    }
  }

  for (const entry of INFRASTRUCTURE_PACKAGES) {
    assert.ok(
      entry.reason.trim().length > 0,
      `Infrastructure allowance for ${entry.name} has no reason. An allowance without a stated reason is an unguarded hole.`,
    );
    assert.ok(
      [...specifiers].some((specifier) => isPackage(specifier, entry.name)),
      `${entry.name} is allowed through the capability-import guard but nothing in apps/backend/src imports it any more. Delete the allowance — leaving it lets a genuine capability import slip in under a name nobody is watching.`,
    );
  }
});

test("every strict directory still exists and still has teeth", () => {
  for (const entry of INFRASTRUCTURE_STRICT_DIRECTORIES) {
    assert.ok(
      entry.reason.trim().length > 0,
      `Strict-directory rule for ${entry.directory} has no reason. A rule nobody can justify is a rule nobody will keep.`,
    );

    // A renamed or deleted directory turns the rule into a no-op that still
    // reads as protection.
    const absolute = join(SRC_ROOT, entry.directory);
    const files = existsSync(absolute)
      ? typeScriptFiles(absolute).filter((filePath) =>
          isInStrictDirectory(relativeToSrc(filePath)),
        )
      : [];
    assert.ok(
      files.length > 0,
      `${entry.directory} is listed as a strict directory but contains no TypeScript files under that path. It was probably moved or renamed — move the entry with it, or delete it. Left as is, the rule guards nothing while still looking like it does.`,
    );

    // And the rule has to actually differ from the general one: infrastructure
    // packages must be rejected here and accepted elsewhere. If
    // INFRASTRUCTURE_PACKAGES ever empties out, this entry is redundant.
    assert.ok(
      INFRASTRUCTURE_PACKAGES.length > 0,
      `${entry.directory} is listed as a strict directory, but INFRASTRUCTURE_PACKAGES is empty, so "strict" now means exactly what the general rule already means. Delete the entry.`,
    );
    assert.equal(
      isInStrictDirectory(`${entry.directory}/probe.ts`),
      true,
      `${entry.directory} does not match its own path prefix. The strict rule is not being applied to the directory it names.`,
    );
    assert.equal(
      isInStrictDirectory(`${entry.directory}-sibling/probe.ts`),
      false,
      `${entry.directory} matches a sibling directory that merely shares its prefix. The strict rule is over-applying.`,
    );
  }
});

test("every file exemption is justified and still needed", () => {
  for (const entry of FILE_EXEMPTIONS) {
    assert.ok(
      entry.reason.trim().length > 0,
      `Exemption for ${entry.file} has no reason. An exemption without a stated reason is an unguarded hole.`,
    );
    const filePath = join(SRC_ROOT, entry.file);
    assert.ok(
      capabilityReferences(filePath, entry.file).length > 0,
      `${entry.file} is exempted from the capability-import guard but no longer imports a capability package. Delete the exemption so the file is guarded again.`,
    );
  }
});
