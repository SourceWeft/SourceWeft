import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import ts from "typescript";

/**
 * Subdomain boundaries inside `modules/threads` (T2.3).
 *
 * The threads module has three code subdomains with distinct jobs:
 *
 *   - `durable/`  — run lifecycle: jobs, recovery, approval, run state (plus
 *                   the room/presence services that physically live here);
 *   - `stream/`   — SSE delivery of a run to clients;
 *   - `agent/`    — turn execution against the model.
 *
 * Each of them may depend on the others — a run is delivered, a delivery
 * executes a turn — but the dependency is supposed to cross at one door: the
 * other subdomain's `index.ts`. A deep import (`../agent/turn/runner` instead
 * of `../agent`) couples the importer to the other subdomain's private file
 * layout, so moving a file inside one subdomain breaks its neighbours, and
 * the index stops being an honest statement of what the subdomain offers.
 *
 * Unlike the model-gateway guard, *type-only* imports count here. That guard
 * exists to stop unbilled runtime access, which an erased type import cannot
 * perform; this one exists to stop path coupling, and a type import couples
 * to the file path exactly as hard as a value import — rename the file and
 * both break the same way.
 *
 * Everything that violated the rule when it was introduced is frozen in
 * ALLOWED_CROSS_IMPORTS below, so this test is green today; its value is
 * that no *new* deep cross-subdomain import can appear silently. Files
 * elsewhere in the module (`turn/`, `thread/`, the module root, and
 * `threads/index.ts` itself) are not governed by this rule — only imports
 * between the three subdomains are.
 *
 * Sibling guards of the same shape: `src/architecture-capability-imports
 * .test.ts`, `src/shared/model-gateway/architecture.test.ts`.
 */

const THREADS_ROOT = dirname(fileURLToPath(import.meta.url));

const SUBDOMAINS = ["durable", "stream", "agent"] as const;
type Subdomain = (typeof SUBDOMAINS)[number];

/**
 * Deep cross-subdomain imports that predate the rule, each frozen with the
 * reason it exists and, implicitly, its exit: move the import to the target
 * subdomain's `index.ts` (every member below is already re-exported there
 * where a value is involved) and delete the entry. Adding an entry is a
 * decision that needs the same justification; the self-check test below
 * deletes stale ones for you by failing.
 *
 * `from` is a file, relative to `modules/threads`; `to` is the resolved,
 * extensionless import target, also relative to `modules/threads`.
 */
const ALLOWED_CROSS_IMPORTS: readonly {
  readonly from: string;
  readonly to: string;
  readonly reason: string;
}[] = [
  // ---- durable → stream -------------------------------------------------
  {
    from: "durable/runner.ts",
    to: "stream/error",
    reason:
      "The durable runner persists stream-shaped error turns itself: run orchestration is delivery orchestration today; awaiting migration to stream/index.",
  },
  {
    from: "durable/runner.ts",
    to: "stream/helpers",
    reason:
      "The runner encodes replayed events with toSseData, the stream wire encoder; awaiting migration to stream/index.",
  },
  {
    from: "durable/runner.ts",
    to: "stream/service",
    reason:
      "The durable run job drives ContentThreadStreamService directly — the run/delivery seam lives inside the runner; awaiting migration to stream/index.",
  },
  {
    from: "durable/service.ts",
    to: "stream/types",
    reason:
      "Durable run modes are keyed by the stream request shapes (edit/refresh/resume); type-only, awaiting migration to stream/index.",
  },
  {
    from: "durable/types.ts",
    to: "stream/types",
    reason:
      "Run payload types embed the stream request shapes they replay; type-only, awaiting migration to stream/index.",
  },
  // ---- durable → agent --------------------------------------------------
  {
    from: "durable/run-recovery.ts",
    to: "agent/sandbox-service/service",
    reason:
      "Recovery releases the interrupted turn's sandbox lease, reaching straight into the agent's sandbox service; awaiting migration to agent/index.",
  },
  {
    from: "durable/types.ts",
    to: "agent/citation-registry",
    reason:
      "Run result snapshots carry the turn's AgentCitations; type-only, awaiting migration to agent/index.",
  },
  // ---- stream → agent ---------------------------------------------------
  {
    from: "stream/error.ts",
    to: "agent/citation-registry",
    reason:
      "Partial error state persists the citations the turn had produced; type-only, awaiting migration to agent/index.",
  },
  {
    from: "stream/event-mapper.ts",
    to: "agent/turn/runner",
    reason:
      "The SSE mapper is typed by the agent turn event union it maps; type-only, awaiting migration to agent/index.",
  },
  {
    from: "stream/event-mapper.test.ts",
    to: "agent/turn/runner",
    reason:
      "The mapper's test fabricates agent turn events to feed it; type-only, follows wherever the mapper's import goes.",
  },
  {
    from: "stream/observability.ts",
    to: "agent/turn/runner",
    reason:
      "Trace output builders are typed by the turn outcome; carved out of stream/service.ts in the T2.3 split — same coupling, same debt, awaiting migration to agent/index.",
  },
  {
    from: "stream/observability.ts",
    to: "agent/citation-registry",
    reason:
      "Citation observations are typed by AgentCitation; carved out of stream/service.ts in the T2.3 split, awaiting migration to agent/index.",
  },
  {
    from: "stream/observability.ts",
    to: "agent/middleware/tool-execution-timeout",
    reason:
      "toObservationError classifies the middleware's termination-unknown failure; carved out of stream/service.ts in the T2.3 split, awaiting migration to agent/index.",
  },
  {
    from: "stream/run-trace-state.ts",
    to: "agent/turn/runner",
    reason:
      "The finish-event confirmation payload reads the turn outcome type; carved out of stream/service.ts in the T2.3 split, awaiting migration to agent/index.",
  },
  {
    from: "stream/run-trace-state.ts",
    to: "agent/turn/tool-tracker",
    reason:
      "write_todos tool calls are hidden from visible trace parts by the tracker's name constant; carved out of stream/service.ts in the T2.3 split, awaiting migration to agent/index.",
  },
  {
    from: "stream/run-trace-state.ts",
    to: "agent/citation-registry",
    reason:
      "Partial error state carries the run's citations; type-only, carved out of stream/service.ts in the T2.3 split, awaiting migration to agent/index.",
  },
  {
    from: "stream/service.ts",
    to: "agent/turn/runner",
    reason:
      "The stream service invokes the agent turn runner — the delivery/execution seam itself. Deliberately NOT migrating to agent/index: a value re-export of turn/runner there closes a runtime cycle (agent/index → turn/runner → turn/checkpoint → agent/index), so the deep value import is the permanent shape; the index offers the turn types only.",
  },
  {
    from: "stream/service.ts",
    to: "agent/sandbox-service/service",
    reason:
      "An abandoned stream releases the turn's sandbox lease directly; awaiting migration to agent/index.",
  },
  {
    from: "stream/service.ts",
    to: "agent/citation-registry",
    reason:
      "The stream accumulates the turn's AgentCitations; type-only, awaiting migration to agent/index.",
  },
  {
    from: "stream/service.ts",
    to: "agent/middleware/tool-execution-timeout",
    reason:
      "Cancel-vs-failure discrimination probes the middleware's termination-unknown marker; awaiting migration to agent/index.",
  },
  {
    from: "stream/service.test.ts",
    to: "agent/turn/runner",
    reason:
      "The service test fabricates agent turn events/outcomes for its fake runner; type-only, follows wherever the service's import goes.",
  },
  {
    from: "stream/service.test.ts",
    to: "agent/middleware/tool-execution-timeout",
    reason:
      "The service test raises the middleware's error class to assert the stream's failure classification; follows wherever the service's import goes.",
  },
  // ---- agent → durable --------------------------------------------------
  {
    from: "agent/capability-tools/host-services.ts",
    to: "durable/repository",
    reason:
      "Capability host services let a tool request run cancellation, reaching into the durable repository; awaiting migration to durable/index.",
  },
  {
    from: "agent/capability-tools/host-services.ts",
    to: "durable/protected-agent-tool-state-repository",
    reason:
      "Protected tool-state receipt/operation-cache services are bound into capability host services; awaiting migration to durable/index.",
  },
];

/** Parsed once per file, shared by both tests. */
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
 * Every module specifier in a file, from all five syntactic shapes a
 * specifier can take (import, re-export, side-effect import, import-equals,
 * dynamic import). Missing one is how a guard like this becomes decorative.
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
    if (ts.isImportDeclaration(node)) {
      record(node, node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      record(node, node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      record(node, node.moduleReference.expression);
    } else if (
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

function toPosix(path: string) {
  return path.split(sep).join("/");
}

function subdomainOf(relativePath: string): Subdomain | null {
  const first = relativePath.split("/")[0] ?? "";
  return (SUBDOMAINS as readonly string[]).includes(first)
    ? (first as Subdomain)
    : null;
}

/** "agent/turn/runner.ts" → "agent/turn/runner"; "agent/index" → "agent". */
function normalizeTarget(relativePath: string) {
  let target = relativePath;
  if (target.endsWith(".ts")) {
    target = target.slice(0, -".ts".length);
  }
  if (target.endsWith("/index")) {
    target = target.slice(0, -"/index".length);
  }
  return target;
}

type CrossImport = {
  readonly from: string;
  readonly line: number;
  readonly fromSubdomain: Subdomain;
  readonly to: string;
  readonly toSubdomain: Subdomain;
};

/**
 * The cross-subdomain references of one file: every relative specifier that
 * resolves into a *different* guarded subdomain. `to` is normalized, so the
 * subdomain root (`to === toSubdomain`) is the sanctioned index door.
 */
function crossSubdomainImports(filePath: string): CrossImport[] {
  const from = toPosix(relative(THREADS_ROOT, filePath));
  const fromSubdomain = subdomainOf(from);
  if (!fromSubdomain) {
    return [];
  }
  const results: CrossImport[] = [];
  for (const reference of moduleReferences(parse(filePath))) {
    if (!reference.specifier.startsWith(".")) {
      continue;
    }
    const resolved = resolve(dirname(filePath), reference.specifier);
    const relativeToRoot = relative(THREADS_ROOT, resolved);
    if (relativeToRoot.startsWith("..")) {
      continue;
    }
    const to = normalizeTarget(toPosix(relativeToRoot));
    const toSubdomain = subdomainOf(to);
    if (!toSubdomain || toSubdomain === fromSubdomain) {
      continue;
    }
    results.push({
      from,
      line: reference.line,
      fromSubdomain,
      to,
      toSubdomain,
    });
  }
  return results;
}

function isDeep(crossImport: CrossImport) {
  return crossImport.to !== crossImport.toSubdomain;
}

function isExempt(crossImport: CrossImport) {
  return ALLOWED_CROSS_IMPORTS.some(
    (entry) => entry.from === crossImport.from && entry.to === crossImport.to,
  );
}

function subdomainFiles() {
  return SUBDOMAINS.flatMap((subdomain) =>
    typeScriptFiles(join(THREADS_ROOT, subdomain)),
  );
}

test("threads subdomains (durable/stream/agent) cross-import only via each other's index", () => {
  const offenders: string[] = [];

  for (const filePath of subdomainFiles()) {
    for (const crossImport of crossSubdomainImports(filePath)) {
      if (!isDeep(crossImport) || isExempt(crossImport)) {
        continue;
      }
      offenders.push(
        `${crossImport.from}:${crossImport.line} → ${crossImport.to}`,
      );
    }
  }

  assert.deepEqual(
    offenders.sort(),
    [],
    [
      "Deep cross-subdomain import inside modules/threads:",
      ...offenders.map((offender) => `  - ${offender}`),
      "",
      "durable/, stream/ and agent/ import each other only through the other",
      "subdomain's index.ts. A deep path couples you to that subdomain's",
      "private file layout: moving a file there breaks code here, and the",
      "index stops describing what the subdomain actually offers. Type-only",
      "imports count — they break on a rename exactly like value imports.",
      "",
      "Import the member from the subdomain's index instead (`../agent`,",
      "`../stream`, `../durable`). If it is not exported there, add a",
      "re-export to that index — that is a one-line, cycle-checked change.",
      "Only if routing through the index is genuinely impossible, add an",
      "ALLOWED_CROSS_IMPORTS entry with the reason; that list is frozen debt,",
      "not a convenience.",
    ].join("\n"),
  );
});

test("every allowed cross-import is justified, real, and still needed", () => {
  const seen = new Set<string>();
  for (const entry of ALLOWED_CROSS_IMPORTS) {
    const key = `${entry.from} → ${entry.to}`;
    assert.ok(
      !seen.has(key),
      `Duplicate ALLOWED_CROSS_IMPORTS entry: ${key}. Delete one.`,
    );
    seen.add(key);

    assert.ok(
      entry.reason.trim().length > 0,
      `Exemption ${key} has no reason. An exemption without a stated reason is an unguarded hole; either fix the import or write down why it stands.`,
    );

    // The entry must describe something this rule would actually forbid —
    // otherwise it reads as protection while guarding nothing.
    const fromSubdomain = subdomainOf(entry.from);
    const toSubdomain = subdomainOf(entry.to);
    assert.ok(
      fromSubdomain,
      `Exemption ${key}: "${entry.from}" is not inside a guarded subdomain (${SUBDOMAINS.join(", ")}), so the rule never applies to it. Delete the entry.`,
    );
    assert.ok(
      toSubdomain && toSubdomain !== fromSubdomain,
      `Exemption ${key}: "${entry.to}" is not in a *different* guarded subdomain, so the rule never applies to it. Delete the entry.`,
    );
    assert.ok(
      entry.to !== toSubdomain,
      `Exemption ${key}: "${entry.to}" is the subdomain's index, which is always allowed. Delete the entry.`,
    );

    const filePath = join(THREADS_ROOT, entry.from);
    assert.ok(
      existsSync(filePath),
      `Exemption ${key} points at ${entry.from}, which no longer exists. Delete the stale entry.`,
    );
    assert.ok(
      crossSubdomainImports(filePath).some(
        (crossImport) => crossImport.to === entry.to,
      ),
      `${entry.from} is exempted for a deep import of ${entry.to} but no longer imports it. Delete the exemption so the file is fully guarded again.`,
    );
  }
});

test("each subdomain has the index door the rule points at", () => {
  for (const subdomain of SUBDOMAINS) {
    assert.ok(
      existsSync(join(THREADS_ROOT, subdomain, "index.ts")),
      `modules/threads/${subdomain}/index.ts is missing. The boundary rule tells offenders to import through it; without the file the only way to satisfy the rule is to grow ALLOWED_CROSS_IMPORTS, which defeats it. Restore the index (re-exporting the members sibling subdomains reference).`,
    );
  }
});
