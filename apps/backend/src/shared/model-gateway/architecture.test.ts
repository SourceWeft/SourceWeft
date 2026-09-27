import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import ts from "typescript";

/**
 * Architecture guard for the billing boundary.
 *
 * Every model call in this app has to settle against a billing scope. That is
 * enforced structurally rather than by review: `withBilledModelGateway` /
 * `openBilledModelGateway` in `src/shared/model-gateway/index.ts` are the only
 * doors to a model, and they take a billing intent. A module that imports
 * `@sourceweft/model-gateway` directly walks around that door — the call still
 * works, tokens still burn at the provider, and nothing is ever charged. The
 * failure is invisible: no error, no failing test, just revenue quietly
 * leaking on every request that took the shortcut.
 *
 * `eslint.config.js` states the same rule, but a lint rule only guards what
 * actually runs. This test runs with the rest of the backend suite, so the
 * invariant is checked on every `pnpm test`.
 *
 * Only *value* imports are violations. `import type { ChatCompleteInput }` is
 * erased at compile time and carries no runtime access, so it cannot reach a
 * model and cannot bypass billing — it stays allowed, matching the lint rule's
 * `allowTypeImports: true`.
 */

const GATEWAY_PACKAGE = "@sourceweft/model-gateway";

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The gateway boundary itself: the one place that is supposed to wrap the
 * package, and the place that adds the billing intent everyone else consumes.
 */
const ALLOWED_PREFIX = join("shared", "model-gateway") + sep;

/**
 * Known violations that have not been migrated yet. This list is the visible
 * to-do record — it exists so this guard can be green today without weakening
 * the rule for anything new. Every entry states why it is still here and what
 * closing it looks like. Adding an entry is a decision that needs the same
 * justification; the empty-allowlist version of this guard would be worthless.
 */
const EXEMPTIONS: { file: string; reason: string }[] = [
  {
    file: join("scripts", "smoke-orcarouter-observation.ts"),
    reason:
      "Manual smoke tool, run by hand against an operator-supplied " +
      "ORCAROUTER_API_KEY to verify observation normalization (resolved " +
      "model, request id, inline usage cost). It serves no user traffic and " +
      "burning the operator's own tokens unmetered is its purpose; wrapping " +
      "it in withBilledModelGateway would charge a billing scope for a " +
      "connectivity probe.",
  },
];

function isExempt(relativePath: string): boolean {
  return EXEMPTIONS.some((entry) => entry.file === relativePath);
}

function listTypeScriptFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") {
        continue;
      }
      files.push(...listTypeScriptFiles(full));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Decide whether a single import/export declaration is a *value* reference to
 * the gateway package.
 *
 * Done with the TypeScript parser rather than a regex because the distinction
 * lives inside the syntax tree, not in the text: `import { type A, B } from ...`
 * is a value import (of `B`) while `import { type A, type B } from ...` is not,
 * and both can be spread over several lines. `importClause.isTypeOnly` covers
 * `import type { ... }`; when it is false, each named specifier carries its own
 * `isTypeOnly` flag, and a default or namespace binding is always a value.
 */
function isValueGatewayImport(node: ts.Node): boolean {
  let moduleSpecifier: ts.Expression | undefined;
  let clause: ts.ImportClause | undefined;
  let isTypeOnlyDeclaration = false;
  let namedBindings: ts.NamedImports | ts.NamedExports | undefined;
  let hasNonNamedBinding = false;

  if (ts.isImportDeclaration(node)) {
    moduleSpecifier = node.moduleSpecifier;
    clause = node.importClause;
    if (!clause) {
      // `import "@sourceweft/model-gateway"` — side-effect import, executes the
      // module, so it counts as runtime access.
      return isGatewaySpecifier(moduleSpecifier);
    }
    isTypeOnlyDeclaration = clause.isTypeOnly;
    if (clause.name) {
      hasNonNamedBinding = true;
    }
    if (clause.namedBindings) {
      if (ts.isNamespaceImport(clause.namedBindings)) {
        hasNonNamedBinding = true;
      } else {
        namedBindings = clause.namedBindings;
      }
    }
  } else if (ts.isExportDeclaration(node)) {
    // `export { X } from "@sourceweft/model-gateway"` re-exports a value just
    // as effectively as importing it.
    moduleSpecifier = node.moduleSpecifier;
    isTypeOnlyDeclaration = node.isTypeOnly;
    if (node.exportClause && ts.isNamedExports(node.exportClause)) {
      namedBindings = node.exportClause;
    } else {
      hasNonNamedBinding = true;
    }
  } else {
    return false;
  }

  if (!isGatewaySpecifier(moduleSpecifier)) {
    return false;
  }
  if (isTypeOnlyDeclaration) {
    return false;
  }
  if (hasNonNamedBinding) {
    return true;
  }
  if (!namedBindings) {
    return false;
  }
  return namedBindings.elements.some((element) => !element.isTypeOnly);
}

function isGatewaySpecifier(specifier: ts.Expression | undefined): boolean {
  if (!specifier || !ts.isStringLiteral(specifier)) {
    return false;
  }
  return (
    specifier.text === GATEWAY_PACKAGE ||
    specifier.text.startsWith(`${GATEWAY_PACKAGE}/`)
  );
}

function valueGatewayImportLines(filePath: string): number[] {
  const source = readFileSync(filePath, "utf8");
  if (!source.includes(GATEWAY_PACKAGE)) {
    return [];
  }
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
  const lines: number[] = [];
  for (const statement of sourceFile.statements) {
    if (isValueGatewayImport(statement)) {
      lines.push(
        sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile))
          .line + 1,
      );
    }
  }
  return lines;
}

test("only src/shared/model-gateway may value-import @sourceweft/model-gateway", () => {
  const offenders: string[] = [];

  for (const filePath of listTypeScriptFiles(SRC_ROOT)) {
    const relativePath = relative(SRC_ROOT, filePath);
    if (relativePath.startsWith(ALLOWED_PREFIX) || isExempt(relativePath)) {
      continue;
    }
    for (const line of valueGatewayImportLines(filePath)) {
      offenders.push(`src/${relativePath.split(sep).join("/")}:${line}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    [
      `Value import of ${GATEWAY_PACKAGE} outside src/shared/model-gateway:`,
      ...offenders.map((offender) => `  - ${offender}`),
      "",
      "Reaching the gateway package directly skips the billing intent, so the",
      "model call runs unmetered: the provider bills us for the tokens and the",
      "team is never charged. Nothing fails at runtime, which is exactly why",
      "this has to be caught here.",
      "",
      "Use withBilledModelGateway / openBilledModelGateway from",
      "src/shared/model-gateway/index.ts instead. If you only need a type, make",
      "it `import type` (erased at compile time, so it cannot bypass billing).",
      "If you need a runtime value that is provably not a way to reach a model",
      "(e.g. ModelGatewayError), re-export it from src/shared/model-gateway and",
      "import it from there.",
    ].join("\n"),
  );
});

test("every gateway-boundary exemption is justified and still needed", () => {
  for (const entry of EXEMPTIONS) {
    assert.ok(
      entry.reason.trim().length > 0,
      `Exemption for ${entry.file} has no reason. An exemption without a stated reason is an unguarded hole; either fix the import or write down why it stands.`,
    );
    const exemptPath = join(SRC_ROOT, entry.file);
    assert.ok(
      existsSync(exemptPath),
      `Exemption points at ${entry.file}, which no longer exists. Delete the stale entry.`,
    );
    assert.notDeepEqual(
      valueGatewayImportLines(exemptPath),
      [],
      `${entry.file} is exempted from the gateway import guard but no longer value-imports ${GATEWAY_PACKAGE}. Delete the exemption so the file is guarded again.`,
    );
  }
});

/**
 * Architecture guard for the system model (`system-client.ts`).
 *
 * `withSystemModel` is the unbilled door: its calls run on the platform's
 * dedicated key and no tenant is ever charged. That is right for the market's
 * own catalog work and wrong for anything a tenant triggers, which must go
 * through withBilledModelGateway. So only the market modules may open it, and
 * the door itself must be built by the same builder tenant calls use, so the
 * endpoint policy, capability rules, timeouts and retries cannot drift.
 */

const SYSTEM_CLIENT = join(
  SRC_ROOT,
  "shared",
  "model-gateway",
  "system-client",
);
const SYSTEM_MODEL_EXPORT = "withSystemModel";

const SYSTEM_MODEL_CALLERS = [
  join("modules", "skills", "market") + sep,
  join("modules", "market") + sep,
  join("modules", "catalog-overview") + sep,
];

/** The module itself and its own tests. */
function isSystemClientOwnFile(relativePath: string): boolean {
  const prefix = join("shared", "model-gateway", "system-client");
  return (
    relativePath === `${prefix}.ts` ||
    (relativePath.startsWith(prefix) && relativePath.endsWith(".test.ts"))
  );
}

const SYSTEM_MODEL_EXEMPTIONS: { file: string; reason: string }[] = [
  {
    file: join("scripts", "smoke-system-model.ts"),
    reason:
      "Manual smoke tool, run by hand by an operator to prove one real " +
      "structured-output call through the dedicated SYSTEM_MODEL_API_KEY. It " +
      "serves no tenant traffic, and exercising the unbilled door is its " +
      "whole purpose.",
  },
];

function isSystemModelCallerAllowed(relativePath: string): boolean {
  return (
    SYSTEM_MODEL_CALLERS.some((prefix) => relativePath.startsWith(prefix)) ||
    isSystemClientOwnFile(relativePath) ||
    SYSTEM_MODEL_EXEMPTIONS.some((entry) => entry.file === relativePath)
  );
}

function resolvesToSystemClient(filePath: string, specifier: string): boolean {
  if (!specifier.startsWith(".")) return false;
  const target = resolve(dirname(filePath), specifier).replace(
    /\.(ts|js)$/,
    "",
  );
  return target === SYSTEM_CLIENT;
}

/**
 * Lines where a file reaches `withSystemModel`: a named value import or
 * re-export of it, a default or namespace import or `export *` of the module
 * (which carries it), or a dynamic import of the module. Its other exports —
 * readiness, types — are free to use anywhere.
 */
function systemModelImportLines(filePath: string, source: string): number[] {
  if (!source.includes("system-client")) return [];
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
  const lines: number[] = [];
  const lineOf = (node: ts.Node) =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line +
    1;
  const namesExport = (
    elements: ts.NodeArray<ts.ImportSpecifier | ts.ExportSpecifier>,
  ) =>
    elements.some(
      (element) =>
        !element.isTypeOnly &&
        (element.propertyName ?? element.name).text === SYSTEM_MODEL_EXPORT,
    );

  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      resolvesToSystemClient(filePath, statement.moduleSpecifier.text)
    ) {
      const clause = statement.importClause;
      if (!clause || clause.isTypeOnly) continue;
      const bindings = clause.namedBindings;
      if (
        clause.name ||
        (bindings && ts.isNamespaceImport(bindings)) ||
        (bindings &&
          ts.isNamedImports(bindings) &&
          namesExport(bindings.elements))
      ) {
        lines.push(lineOf(statement));
      }
    } else if (
      ts.isExportDeclaration(statement) &&
      !statement.isTypeOnly &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      resolvesToSystemClient(filePath, statement.moduleSpecifier.text)
    ) {
      const clause = statement.exportClause;
      if (
        !clause ||
        !ts.isNamedExports(clause) ||
        namesExport(clause.elements)
      ) {
        lines.push(lineOf(statement));
      }
    }
  }

  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const [argument] = node.arguments;
      if (
        argument &&
        ts.isStringLiteral(argument) &&
        resolvesToSystemClient(filePath, argument.text)
      ) {
        lines.push(lineOf(node));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return lines;
}

function systemModelOffenders(files: { path: string; source: string }[]) {
  const offenders: string[] = [];
  for (const file of files) {
    const relativePath = relative(SRC_ROOT, file.path);
    if (isSystemModelCallerAllowed(relativePath)) continue;
    for (const line of systemModelImportLines(file.path, file.source)) {
      offenders.push(`src/${relativePath.split(sep).join("/")}:${line}`);
    }
  }
  return offenders;
}

test("only the market modules may reach withSystemModel", () => {
  const offenders = systemModelOffenders(
    listTypeScriptFiles(SRC_ROOT).map((path) => ({
      path,
      source: readFileSync(path, "utf8"),
    })),
  );
  assert.deepEqual(
    offenders,
    [],
    [
      `${SYSTEM_MODEL_EXPORT} is imported outside the market modules:`,
      ...offenders.map((offender) => `  - ${offender}`),
      "",
      "The system model charges nobody: its calls run on the platform's",
      "dedicated key. Work a tenant triggers must be billed to that tenant",
      "through withBilledModelGateway instead.",
    ].join("\n"),
  );
});

test("the system-model guard catches every way of reaching withSystemModel", () => {
  const at = (path: string, source: string) => ({
    path: join(SRC_ROOT, path),
    source,
  });
  const fromThreads = "../../shared/model-gateway/system-client";
  const fromMarket = "../../../shared/model-gateway/system-client";
  const offenders = systemModelOffenders([
    at(
      join("modules", "threads", "a.ts"),
      `import { withSystemModel } from "${fromThreads}";`,
    ),
    at(
      join("modules", "threads", "b.ts"),
      `import {\n  type SystemModelPurpose,\n  withSystemModel as run,\n} from "${fromThreads}.ts";`,
    ),
    at(
      join("modules", "threads", "c.ts"),
      `import * as system from "${fromThreads}";`,
    ),
    at(
      join("modules", "threads", "d.ts"),
      `export { withSystemModel } from "${fromThreads}";`,
    ),
    at(
      join("modules", "threads", "e.ts"),
      `export async function f() {\n  return import("${fromThreads}");\n}`,
    ),
    at(join("modules", "threads", "f.ts"), `export * from "${fromThreads}";`),
    // Readiness and types are free to use; the market may call the model.
    at(
      join("modules", "threads", "g.ts"),
      `import { getSystemModelReadiness } from "${fromThreads}";\nimport type { SystemModelPurpose } from "${fromThreads}";`,
    ),
    at(
      join("modules", "market", "parser", "h.ts"),
      `import { withSystemModel } from "${fromMarket}";`,
    ),
    at(
      join("modules", "skills", "market", "i.ts"),
      `import { withSystemModel } from "${fromMarket}";`,
    ),
    at(
      join("modules", "catalog-overview", "j.ts"),
      `import { withSystemModel } from "${fromThreads}";`,
    ),
  ]);
  assert.deepEqual(offenders, [
    "src/modules/threads/a.ts:1",
    "src/modules/threads/b.ts:1",
    "src/modules/threads/c.ts:1",
    "src/modules/threads/d.ts:1",
    "src/modules/threads/e.ts:2",
    "src/modules/threads/f.ts:1",
  ]);
});

test("every system-model exemption is justified and still needed", () => {
  for (const entry of SYSTEM_MODEL_EXEMPTIONS) {
    assert.ok(entry.reason.trim().length > 0, `${entry.file} has no reason`);
    const exemptPath = join(SRC_ROOT, entry.file);
    assert.ok(
      existsSync(exemptPath),
      `Exemption points at ${entry.file}, which no longer exists. Delete the stale entry.`,
    );
    assert.notDeepEqual(
      systemModelImportLines(exemptPath, readFileSync(exemptPath, "utf8")),
      [],
      `${entry.file} no longer reaches ${SYSTEM_MODEL_EXPORT}. Delete the exemption.`,
    );
  }
});

test("system-client.ts builds its gateway through buildRoutedModelGatewayConfig", () => {
  const path = `${SYSTEM_CLIENT}.ts`;
  const sourceFile = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
  const isBuilderCall = (node: ts.Node | undefined) =>
    node !== undefined &&
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "buildRoutedModelGatewayConfig";
  const gatewayArguments: Array<ts.Expression | undefined> = [];
  const identifiers = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node)) identifiers.add(node.text);
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "createModelGateway"
    ) {
      gatewayArguments.push(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const importsBuilder = sourceFile.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "./runtime" &&
      statement.importClause?.namedBindings !== undefined &&
      ts.isNamedImports(statement.importClause.namedBindings) &&
      statement.importClause.namedBindings.elements.some(
        (element) => element.name.text === "buildRoutedModelGatewayConfig",
      ),
  );
  assert.ok(importsBuilder, "system-client.ts must import the shared builder");
  assert.ok(gatewayArguments.length > 0, "system-client.ts creates no gateway");
  for (const argument of gatewayArguments) {
    // Either the builder's result itself, or that result spread with nothing
    // on top but the system client's own target-health registry.
    const built =
      isBuilderCall(argument) ||
      (argument !== undefined &&
        ts.isObjectLiteralExpression(argument) &&
        argument.properties.some(
          (property) =>
            ts.isSpreadAssignment(property) &&
            isBuilderCall(property.expression),
        ) &&
        argument.properties.every(
          (property) =>
            (ts.isSpreadAssignment(property) &&
              isBuilderCall(property.expression)) ||
            (ts.isPropertyAssignment(property) &&
              ts.isIdentifier(property.name) &&
              property.name.text === "targetHealth"),
        ));
    assert.ok(
      built,
      "system-client.ts must hand createModelGateway the output of buildRoutedModelGatewayConfig",
    );
  }
  // The fetch, the endpoint policy and the capability rules come from the
  // builder only.
  for (const name of [
    "createLlmFetch",
    "llmEndpointPolicy",
    "MODEL_CAPABILITY_DB",
  ]) {
    assert.equal(
      identifiers.has(name),
      false,
      `system-client.ts must not assemble ${name} itself`,
    );
  }
});
