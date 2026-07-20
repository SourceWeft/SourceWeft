import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import ts from "typescript";

/**
 * Architecture guards for the host↔capability tool boundary.
 *
 * Two invariants hold this boundary up, and both fail silently when broken —
 * which is why they are asserted here rather than left to review.
 *
 * 1. `context` and `services` are named contract types. They were
 *    `Record<string, unknown>` for a long time, and while they were, nothing
 *    checked that a capability asking for `services.storage` would get one. A
 *    capability whose request went unanswered did not crash: its factory took
 *    the early-return branch and the tool simply never appeared on the turn.
 *    The regression is one edit away — widening either member back to a record
 *    or an inline literal restores exactly that silence.
 *
 * 2. The builders declare their return type. An inferred return type accepts
 *    any extra member, so capability-specific configuration can be dropped into
 *    a bag that every capability receives (a deck renderer's font base URL once
 *    was). With the annotation, excess-property checking rejects it at the line
 *    that adds it.
 *
 * The TypeScript parser is used rather than a regex because both facts live in
 * the syntax tree: `services?: Partial<X>` and `services?: { [k: string]:
 * unknown }` differ in shape, not in text that a regex can tell apart, and a
 * return type annotation can be spread over as many lines as it likes.
 */

const HOST_DIR = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(HOST_DIR, "..", "..", "..", "..");

function parse(filePath: string) {
  return ts.createSourceFile(
    filePath,
    readFileSync(filePath, "utf8"),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
}

function findTypeAlias(sourceFile: ts.SourceFile, name: string) {
  for (const statement of sourceFile.statements) {
    if (ts.isTypeAliasDeclaration(statement) && statement.name.text === name) {
      return statement;
    }
  }
  return undefined;
}

/** The root identifier of a type reference: `A<B>` → `A`, `A.B` → `A.B`. */
function typeReferenceName(node: ts.TypeNode | undefined): string | null {
  if (!node || !ts.isTypeReferenceNode(node)) {
    return null;
  }
  return node.typeName.getText(node.getSourceFile());
}

test("the capability factory input keeps context and services named contract types", () => {
  const typesPath = join(HOST_DIR, "types.ts");
  const sourceFile = parse(typesPath);
  const alias = findTypeAlias(sourceFile, "CapabilityAgentToolFactoryInput");
  assert.ok(
    alias && ts.isTypeLiteralNode(alias.type),
    "CapabilityAgentToolFactoryInput is no longer an object type in types.ts. It is the host's half of the agent tool contract; if it moved, move this guard with it rather than deleting it.",
  );

  const members = new Map<string, ts.TypeNode | undefined>();
  for (const member of (alias.type as ts.TypeLiteralNode).members) {
    if (ts.isPropertySignature(member) && ts.isIdentifier(member.name)) {
      members.set(member.name.text, member.type);
    }
  }

  for (const [property, expected] of [
    ["context", "CapabilityAgentToolTurnContext"],
    ["services", "CapabilityAgentToolHostServices"],
  ] as const) {
    const declared = members.get(property);
    assert.ok(
      declared,
      `CapabilityAgentToolFactoryInput no longer declares "${property}". Every capability reads it; dropping it here does not fail any capability's build, it just stops the bag being passed.`,
    );
    assert.equal(
      typeReferenceName(declared),
      expected,
      `CapabilityAgentToolFactoryInput.${property} must stay the named type ${expected}, which resolves to the shared declaration in @sourceweft/contracts/agent-tools. An inline object, a Record or an any/unknown here un-checks the whole host↔capability contract: a capability can ask for a service the host does not provide, and the only symptom is a tool that quietly never binds.`,
    );
  }
});

test("the host builders declare their contract return types", () => {
  for (const [file, fn, expected] of [
    [
      "host-services.ts",
      "createCapabilityAgentToolHostServices",
      "CapabilityAgentToolHostServices",
    ],
    [
      "turn-context.ts",
      "createCapabilityAgentToolTurnContext",
      "CapabilityAgentToolTurnContext",
    ],
  ] as const) {
    const sourceFile = parse(join(HOST_DIR, file));
    const declaration = sourceFile.statements.find(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === fn,
    );
    assert.ok(declaration, `${file} no longer declares ${fn}.`);
    assert.equal(
      typeReferenceName(declaration.type),
      expected,
      `${fn} must annotate its return type as ${expected}. Without the annotation the returned literal is inferred, so an extra member — configuration only one capability reads — can be added to a bag handed to every capability, and nothing objects. With it, excess-property checking rejects the addition where it is written.`,
    );
  }
});

/**
 * Known capability imports in the host's tool binder. One entry, and it is the
 * one the north star is aimed at: `apps/backend/src` is meant to name no
 * capability at all.
 */
const CAPABILITY_IMPORT_EXEMPTIONS: { file: string; reason: string }[] = [
  {
    file: "types.ts",
    // TODO(capability-boundary): the sandbox runtime a turn holds is host
    // state; move `AgentSandboxRuntimeForTurn`'s shape into
    // `@sourceweft/contracts` (as `AgentToolSandboxRuntime`) and have the
    // sandbox package alias it, the way the web provider port was moved.
    reason:
      "Type-imports AgentSandboxRuntimeForTurn from @sourceweft/builtin-tool-sandbox to type the turn input. Pre-dates this module; the sandbox runtime is threaded through turn assembly, which is not this refactor's to move.",
  },
];

test("the capability tool binder imports no capability package", () => {
  const offenders: string[] = [];

  for (const entry of readdirSync(HOST_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) {
      continue;
    }
    if (CAPABILITY_IMPORT_EXEMPTIONS.some((item) => item.file === entry.name)) {
      continue;
    }
    const filePath = join(HOST_DIR, entry.name);
    const sourceFile = parse(filePath);
    for (const statement of sourceFile.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        continue;
      }
      const specifier = statement.moduleSpecifier.text;
      if (!specifier.startsWith("@sourceweft/builtin-")) {
        continue;
      }
      const line =
        sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile))
          .line + 1;
      offenders.push(
        `src/${relative(SRC_ROOT, filePath).split(sep).join("/")}:${line} → ${specifier}`,
      );
    }
  }

  assert.deepEqual(
    offenders,
    [],
    [
      "The host's capability tool binder imports a capability package:",
      ...offenders.map((offender) => `  - ${offender}`),
      "",
      "This module exists to bind tools it knows nothing about. Naming a",
      "capability here — a package, a tool name, an artifact type, a job name —",
      "is how the host starts depending on which capabilities happen to be",
      "installed, and a capability that is removed or replaced then breaks the",
      "host's build instead of simply not contributing.",
      "",
      "Reach for @sourceweft/contracts (shared types) or",
      "@sourceweft/agent-tool-registry (the static module table) instead. If a",
      "shape genuinely has to be shared, move the declaration into contracts",
      "and alias it from the capability, as the web provider port does.",
    ].join("\n"),
  );
});

test("every capability-import exemption is justified and still needed", () => {
  for (const entry of CAPABILITY_IMPORT_EXEMPTIONS) {
    assert.ok(
      entry.reason.trim().length > 0,
      `Exemption for ${entry.file} has no reason. An exemption without a stated reason is an unguarded hole.`,
    );
    const sourceFile = parse(join(HOST_DIR, entry.file));
    const stillImports = sourceFile.statements.some(
      (statement) =>
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text.startsWith("@sourceweft/builtin-"),
    );
    assert.ok(
      stillImports,
      `${entry.file} is exempted from the capability-import guard but no longer imports a capability package. Delete the exemption so the file is guarded again.`,
    );
  }
});
