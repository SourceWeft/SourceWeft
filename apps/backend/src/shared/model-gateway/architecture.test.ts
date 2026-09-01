import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
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
