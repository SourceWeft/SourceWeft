import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import type { SkillManifestJson } from "@sourceweft/db";

/**
 * Stage 5 index write (docs/architecture/skill-registry-index.md §3 Stage 5).
 * Pins two invariants:
 *   1. the write reuses the storage-invariant guard at the pointer write site;
 *   2. new versions store files, while existing immutable versions are untouched.
 */

// Records of the invariant guards being reused by the registry write path.
const guardCalls = vi.hoisted(() => ({
  invariant: [] as Array<[string, string]>,
  fileWrite: [] as Array<[string]>,
}));

// Tables written inside the transaction, in order.
const dbState = vi.hoisted(() => ({
  ops: [] as Array<{
    op: "insert" | "update" | "select" | "delete";
    table: string;
  }>,
  definitionRows: [] as unknown[],
  versionRows: [] as unknown[],
  fileRows: [] as unknown[],
}));

vi.mock("../repository", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("../repository");
  return {
    ...actual,
    assertRegistryStorageInvariant: (source: never, storage: never) => {
      guardCalls.invariant.push([source, storage]);
      return actual.assertRegistryStorageInvariant(source, storage);
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
      execute: async () => {},
      select() {
        let table = "";
        const builder: Record<string, unknown> = {
          from(t: unknown) {
            table = tableNameOf(t);
            return builder;
          },
          where: () => builder,
          orderBy: () => builder,
          then: (resolve: (rows: unknown[]) => unknown) =>
            Promise.resolve(resolve(dbState.fileRows)),
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
          values: async (rows: unknown) => {
            dbState.ops.push({ op: "insert", table });
            if (table === "skill_version_files") {
              dbState.fileRows.push(...(Array.isArray(rows) ? rows : [rows]));
            }
          },
        };
      },
      delete(t: unknown) {
        const table = tableNameOf(t);
        return {
          where: async () => {
            dbState.ops.push({ op: "delete", table });
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

const { buildRegistryUpsertValues, upsertRegistrySkillIndex } =
  await import("./repository");

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
      {
        path: "SKILL.md",
        sha256: "a".repeat(64),
        sizeBytes: 10,
        role: "model-readable",
      },
    ],
  },
};

function upsertInput(
  overrides: Partial<Parameters<typeof upsertRegistrySkillIndex>[0]> = {},
) {
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
    files: [
      {
        path: "SKILL.md",
        contentText: "---\nname: writer\n---\n",
        mimeType: "text/markdown",
        sizeBytes: 10,
        contentHash: "a".repeat(64),
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  guardCalls.invariant = [];
  dbState.ops = [];
  dbState.definitionRows = [];
  dbState.versionRows = [];
  dbState.fileRows = [];
});

test("buildRegistryUpsertValues stores the bundle like a custom skill", () => {
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
  // Registry skills get no storage type of their own — `repo_builtin` stays
  // reserved for bodies that ship in this repo.
  assert.equal(values.storageType, "db_text");
  assert.equal(values.definition.sourceType, "registry_github");
  assert.equal(values.definition.visibility, "restricted");
  assert.equal(values.version.storageType, "db_text");
  assert.equal(values.version.isCurrent, true);
  // Provenance is still pinned to the immutable commit.
  assert.equal(values.version.storagePointer, "github:acme/skills@sha");
  assert.deepEqual(guardCalls.invariant.at(-1), ["registry_github", "db_text"]);
});

test("a new clean submission writes the definition, version and bundle", async () => {
  const result = await upsertRegistrySkillIndex(upsertInput());
  assert.equal(result.status, "indexed");
  assert.equal(result.version, "a".repeat(12));

  const tablesWritten = dbState.ops
    .filter((op) => op.op !== "select")
    .map((op) => op.table);
  assert.ok(tablesWritten.includes("skill_definitions"));
  assert.ok(tablesWritten.includes("skill_versions"));
  assert.ok(tablesWritten.includes("skill_version_files"));
  assert.equal(dbState.fileRows.length, 1);
  assert.deepEqual(guardCalls.invariant.at(-1), ["registry_github", "db_text"]);
});

test("new versions never delete another version bundle", async () => {
  await upsertRegistrySkillIndex(upsertInput());
  // A file the upstream skill has since dropped must not survive a re-submit.
  const deletes = dbState.ops.filter(
    (op) => op.op === "delete" && op.table === "skill_version_files",
  );
  assert.equal(deletes.length, 0);
});

test("a queued (draft) submission stores its bundle too", async () => {
  const result = await upsertRegistrySkillIndex(
    upsertInput({
      versionStatus: "draft",
      outcome: "queued",
      manifestJson: {
        ...MANIFEST,
        registry: {
          ...MANIFEST.registry!,
          scan: { reviewRequired: true, flags: ["test-risk"] },
        },
      },
    }),
  );
  assert.equal(result.status, "queued");
  // Held back from the catalog by `status`, not by withholding its content.
  assert.equal(dbState.fileRows.length, 1);
});

test("re-submitting an existing source leaves content and status untouched", async () => {
  dbState.definitionRows = [
    {
      id: "def-1",
      ownerUserId: "me",
      sourceType: "registry_github",
      status: "active",
    },
  ];
  dbState.versionRows = [
    {
      id: "ver-1",
      storagePointer: upsertInput().storagePointer,
      status: "published",
      manifestJson: MANIFEST,
    },
  ];
  dbState.fileRows = upsertInput().files;
  const result = await upsertRegistrySkillIndex(upsertInput());
  assert.equal(result.skillVersionId, "ver-1");
  assert.deepEqual(
    dbState.ops.filter((op) => op.op !== "select"),
    [],
  );
});
