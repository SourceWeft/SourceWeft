import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import type { SkillManifestJson } from "@sourceweft/db";

/**
 * Stage 5 index write (docs/architecture/skill-registry-index.md §3 Stage 5).
 * Pins two invariants:
 *   1. the write reuses the storage-invariant guard at the pointer write site;
 *   2. it NEVER writes `skill_version_files` (the redistribution tripwire) — the
 *      fake db below records every table touched, and only definitions/versions
 *      may appear.
 */

// Records of the invariant guards being reused by the registry write path.
const guardCalls = vi.hoisted(() => ({
  invariant: [] as Array<[string, string]>,
  fileWrite: [] as Array<[string]>,
}));

// Tables written inside the transaction, in order.
const dbState = vi.hoisted(() => ({
  ops: [] as Array<{ op: "insert" | "update" | "select"; table: string }>,
  definitionRows: [] as unknown[],
  versionRows: [] as unknown[],
}));

vi.mock("../repository", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("../repository");
  return {
    ...actual,
    assertRegistryStorageInvariant: (source: never, storage: never) => {
      guardCalls.invariant.push([source, storage]);
      return actual.assertRegistryStorageInvariant(source, storage);
    },
    assertNoRegistryFileWrite: (storage: never) => {
      guardCalls.fileWrite.push([storage]);
      return actual.assertNoRegistryFileWrite(storage);
    },
  };
});

vi.mock("@sourceweft/db", async () => {
  const actual =
    await vi.importActual<typeof import("@sourceweft/db")>("@sourceweft/db");

  function tableNameOf(table: unknown): string {
    for (const symbol of Object.getOwnPropertySymbols(table as object)) {
      if (String(symbol).includes("Name")) {
        const value = (table as Record<symbol, unknown>)[symbol];
        if (typeof value === "string") {
          return value;
        }
      }
    }
    return "unknown";
  }

  function makeTx() {
    return {
      select() {
        let table = "";
        const builder: Record<string, unknown> = {
          from(t: unknown) {
            table = tableNameOf(t);
            return builder;
          },
          where: () => builder,
          leftJoin: () => builder,
          innerJoin: () => builder,
          limit: () => {
            dbState.ops.push({ op: "select", table });
            return Promise.resolve(
              table === "skill_definitions"
                ? dbState.definitionRows
                : table === "skill_versions"
                  ? dbState.versionRows
                  : [],
            );
          },
        };
        return builder;
      },
      insert(t: unknown) {
        const table = tableNameOf(t);
        return {
          values: async () => {
            dbState.ops.push({ op: "insert", table });
          },
        };
      },
      update(t: unknown) {
        const table = tableNameOf(t);
        return {
          set: () => ({
            where: async () => {
              dbState.ops.push({ op: "update", table });
            },
          }),
        };
      },
    };
  }

  return {
    ...actual,
    db: {
      transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn(makeTx()),
    },
  };
});

const { buildRegistryUpsertValues, upsertRegistrySkillIndex } = await import(
  "./repository"
);

const MANIFEST: SkillManifestJson = {
  slug: "gh-acme-skills",
  displayName: "Writer",
  version: "abc123",
  description: "Writes prose",
  visibility: "restricted",
  categories: [],
  registry: {
    identifier: "gh:acme/skills",
    sourceUrl: "https://github.com/acme/skills/tree/sha",
    repoUrl: "https://github.com/acme/skills",
    submittedBy: "me",
    capability: "prompt-only",
    scan: { reviewRequired: false, flags: [] },
    license: "MIT",
    fileManifest: [
      { path: "SKILL.md", sha256: "a".repeat(64), sizeBytes: 10, role: "model-readable" },
    ],
  },
};

function upsertInput(overrides: Partial<Parameters<typeof upsertRegistrySkillIndex>[0]> = {}) {
  return {
    slug: "gh-acme-skills",
    displayName: "Writer",
    description: "Writes prose",
    submitterId: "me",
    storagePointer: `github:acme/skills@${"a".repeat(40)}#skills/writer`,
    commitSha: "a".repeat(40),
    contentHash: "a".repeat(64),
    manifestJson: MANIFEST,
    versionStatus: "published" as const,
    outcome: "indexed" as const,
    ...overrides,
  };
}

beforeEach(() => {
  guardCalls.invariant = [];
  guardCalls.fileWrite = [];
  dbState.ops = [];
  dbState.definitionRows = [];
  dbState.versionRows = [];
});

test("buildRegistryUpsertValues asserts invariant 1 and emits the pointer pairing", () => {
  const values = buildRegistryUpsertValues({
    displayName: "Writer",
    description: "d",
    storagePointer: "github:acme/skills@sha",
    contentHash: "h",
    manifestJson: MANIFEST,
    version: "abc123",
    versionStatus: "published",
  });
  assert.equal(values.sourceType, "registry_github");
  assert.equal(values.storageType, "pointer");
  assert.equal(values.definition.sourceType, "registry_github");
  assert.equal(values.definition.visibility, "restricted");
  assert.equal(values.version.storageType, "pointer");
  assert.equal(values.version.isCurrent, true);
  // The pointer write site reused the storage-invariant guard.
  assert.deepEqual(guardCalls.invariant.at(-1), ["registry_github", "pointer"]);
});

test("a new clean submission writes only definition + version, never files", async () => {
  const result = await upsertRegistrySkillIndex(upsertInput());
  assert.equal(result.status, "indexed");
  assert.equal(result.version, "a".repeat(12));

  const tablesWritten = dbState.ops
    .filter((op) => op.op !== "select")
    .map((op) => op.table);
  assert.ok(tablesWritten.includes("skill_definitions"));
  assert.ok(tablesWritten.includes("skill_versions"));
  // Invariant 2: the redistribution tripwire — no file bodies are ever written.
  assert.equal(tablesWritten.includes("skill_version_files"), false);
  // Invariant 1 was reused at the write site.
  assert.deepEqual(guardCalls.invariant.at(-1), ["registry_github", "pointer"]);
});

test("a queued (draft) submission also never writes files", async () => {
  const result = await upsertRegistrySkillIndex(
    upsertInput({ versionStatus: "draft", outcome: "queued" }),
  );
  assert.equal(result.status, "queued");
  const tablesWritten = dbState.ops
    .filter((op) => op.op !== "select")
    .map((op) => op.table);
  assert.equal(tablesWritten.includes("skill_version_files"), false);
});

test("re-submitting an existing slug updates in place (no duplicate definition)", async () => {
  dbState.definitionRows = [{ id: "def-1", ownerUserId: "me" }];
  dbState.versionRows = [{ id: "ver-1" }];
  await upsertRegistrySkillIndex(upsertInput());

  const inserts = dbState.ops.filter((op) => op.op === "insert").map((op) => op.table);
  // Existing definition + version → updates, not inserts.
  assert.equal(inserts.includes("skill_definitions"), false);
  assert.equal(inserts.includes("skill_versions"), false);
  assert.equal(inserts.includes("skill_version_files"), false);
});
