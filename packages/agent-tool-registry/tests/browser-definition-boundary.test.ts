import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

const PACKAGES_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO_ROOT = join(PACKAGES_ROOT, "..");

const BROWSER_ENTRIES = [
  join(PACKAGES_ROOT, "agent-tool-registry", "src", "index.ts"),
  join(
    PACKAGES_ROOT,
    "builtin-tool-video-presentation",
    "src",
    "agent-tool-defs.ts",
  ),
] as const;

const FORBIDDEN_RUNTIME_IMPORTS = new Set([
  "node:path",
  "node:crypto",
  "@sourceweft/model-gateway",
]);

type WorkspacePackage = {
  readonly dir: string;
  readonly exports: Readonly<Record<string, unknown>>;
};

function workspacePackages() {
  const packages = new Map<string, WorkspacePackage>();
  for (const entry of readdirSync(PACKAGES_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(PACKAGES_ROOT, entry.name);
    const packageJsonPath = join(dir, "package.json");
    if (!existsSync(packageJsonPath)) continue;
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      name?: string;
      exports?: Readonly<Record<string, unknown>>;
    };
    if (packageJson.name) {
      packages.set(packageJson.name, {
        dir,
        exports: packageJson.exports ?? {},
      });
    }
  }
  return packages;
}

const WORKSPACE_PACKAGES = workspacePackages();

function runtimeModuleSpecifiers(filePath: string) {
  const source = readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const specifiers = new Set<string>();

  const visit = (node: ts.Node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      const clause = node.importClause;
      const named = clause?.namedBindings;
      const typeOnly =
        clause?.isTypeOnly === true ||
        (clause !== undefined &&
          clause.name === undefined &&
          named !== undefined &&
          ts.isNamedImports(named) &&
          named.elements.length > 0 &&
          named.elements.every((element) => element.isTypeOnly));
      if (!typeOnly) specifiers.add(node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node) &&
      !node.isTypeOnly &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      const clause = node.exportClause;
      const typeOnly =
        clause !== undefined &&
        ts.isNamedExports(clause) &&
        clause.elements.length > 0 &&
        clause.elements.every((element) => element.isTypeOnly);
      if (!typeOnly) specifiers.add(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0]!)
    ) {
      specifiers.add(node.arguments[0]!.text);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return [...specifiers];
}

function sourceFile(path: string): string | null {
  const candidates = [
    path,
    `${path}.ts`,
    `${path}.tsx`,
    `${path}.mts`,
    `${path}.cts`,
    join(path, "index.ts"),
    join(path, "index.tsx"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function workspacePackageFor(specifier: string) {
  const segments = specifier.split("/");
  const packageName = specifier.startsWith("@")
    ? segments.slice(0, 2).join("/")
    : segments[0];
  return packageName ? WORKSPACE_PACKAGES.get(packageName) : undefined;
}

function resolveWorkspaceImport(from: string, specifier: string) {
  if (specifier.startsWith(".")) {
    return sourceFile(resolve(dirname(from), specifier));
  }
  const packageEntry = workspacePackageFor(specifier);
  if (!packageEntry) return null;
  const packageName = specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0]!;
  const subpath = specifier.slice(packageName.length);
  const exportKey = subpath ? `.${subpath}` : ".";
  const target = packageEntry.exports[exportKey];
  return typeof target === "string"
    ? sourceFile(resolve(packageEntry.dir, target))
    : null;
}

function repoRelative(filePath: string) {
  return relative(REPO_ROOT, filePath).split(sep).join("/");
}

test("browser-visible tool definitions do not reach server runtime modules", () => {
  const visited = new Set<string>();
  const violations: string[] = [];

  const walk = (filePath: string, chain: readonly string[]) => {
    if (visited.has(filePath)) return;
    visited.add(filePath);
    for (const specifier of runtimeModuleSpecifiers(filePath)) {
      if (
        FORBIDDEN_RUNTIME_IMPORTS.has(specifier) ||
        [...FORBIDDEN_RUNTIME_IMPORTS].some((forbidden) =>
          specifier.startsWith(`${forbidden}/`),
        )
      ) {
        violations.push(
          [...chain, repoRelative(filePath), specifier].join(" -> "),
        );
        continue;
      }
      const resolved = resolveWorkspaceImport(filePath, specifier);
      if (resolved) walk(resolved, [...chain, repoRelative(filePath)]);
    }
  };

  for (const entry of BROWSER_ENTRIES) walk(entry, []);

  assert.deepEqual(
    violations.sort(),
    [],
    [
      "The isomorphic agent-tool registry/definition graph reached a server runtime dependency:",
      ...violations.sort().map((violation) => `  - ${violation}`),
      "Keep tool names and defineAgentTool metadata in definition-only modules; any runtime hook reachable here must remain browser-safe.",
    ].join("\n"),
  );
});
