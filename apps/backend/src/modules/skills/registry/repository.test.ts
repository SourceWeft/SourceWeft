import assert from "node:assert/strict";
import { unzipSync } from "fflate";
import { beforeEach, test, vi } from "vitest";
import type { SkillManifestJson } from "@sourceweft/db";
import { RegistrySubmissionError } from "./errors";

/**
 * Stage 5 index write (docs/architecture/skill-registry-index.md §3 Stage 5).
 * Pins the write's shape and order:
 *   1. bytes go to object storage BEFORE any row is written, and a failed
 *      object write leaves the database untouched;
 *   2. rows are a manifest — blob key, no content — and the version carries
 *      SKILL.md plus the bundle, whose digest is its content hash;
 *   3. an existing immutable version is returned untouched, and re-writing it
 *      uploads nothing.
 * `../storage` is real; the object store underneath it is a map.
 */

const store = vi.hoisted(() => ({
  objects: new Map<string, { body: Buffer; contentType: string }>(),
  uploads: [] as string[],
  failOn: null as RegExp | null,
}));

// Every write, storage and database alike, in the order it happened.
const dbState = vi.hoisted(() => ({
  ops: [] as Array<{
    op: "insert" | "update" | "select" | "delete" | "upload";
    table: string;
  }>,
  definitionRows: [] as unknown[],
  versionRows: [] as unknown[],
  fileRows: [] as unknown[],
  transactions: 0,
}));

vi.mock("../../sources/storage", () => ({
  getContentStorageBucketName: () => "bucket",
  sandboxAssetObjectExists: async ({ key }: { key: string }) =>
    store.objects.has(key),
  uploadFileObject: async (input: {
    key: string;
    body: Buffer;
    contentType: string;
  }) => {
    if (store.failOn?.test(input.key)) {
      throw new Error("object storage is down");
    }
    store.uploads.push(input.key);
    dbState.ops.push({ op: "upload", table: input.key });
    store.objects.set(input.key, {
      body: input.body,
      contentType: input.contentType,
    });
    return { bucket: "bucket", key: input.key };
  },
}));

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
            const list = Array.isArray(rows) ? rows : [rows];
            if (table === "skill_version_files") dbState.fileRows.push(...list);
            if (table === "skill_versions") dbState.versionRows.push(...list);
            if (table === "skill_definitions")
              dbState.definitionRows.push(...list);
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
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        dbState.transactions += 1;
        return fn(makeTx());
      },
    },
  };
});

const {
  assertSkillStorageInvariant,
  buildRegistryUpsertValues,
  registryVersionTakesCurrent,
  upsertRegistrySkillIndex,
} = await import("./repository");
const { buildSkillBundleZip, sha256Hex } = await import("../storage");

const SKILL_MD = "---\nname: writer\ndescription: Writes prose\n---\nBody\n";
const text = (value: string) => new TextEncoder().encode(value);
// Not valid UTF-8: neither could ever have been a `text` column.
const TTF = new Uint8Array([0x00, 0x01, 0x00, 0x00, 0xff, 0xfe, 0x00]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const FILES = [
  { path: "SKILL.md", bytes: text(SKILL_MD), mimeType: "text/markdown" },
  { path: "fonts/Inter.ttf", bytes: TTF, mimeType: "font/ttf" },
  { path: "assets/cover.png", bytes: PNG, mimeType: "image/png" },
];

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
    committedAt: "2026-02-01T10:00:00.000Z",
    capability: "prompt-only",
    scan: { reviewRequired: false, flags: [] },
    license: "MIT",
    fileManifest: [
      {
        path: "SKILL.md",
        sha256: sha256Hex(text(SKILL_MD)),
        sizeBytes: text(SKILL_MD).byteLength,
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
    manifestJson: MANIFEST,
    versionStatus: "published" as const,
    outcome: "indexed" as const,
    files: FILES,
    ...overrides,
  };
}

const dbWrites = () =>
  dbState.ops.filter((op) => op.op !== "select" && op.op !== "upload");

beforeEach(() => {
  store.objects.clear();
  store.uploads = [];
  store.failOn = null;
  dbState.ops = [];
  dbState.definitionRows = [];
  dbState.versionRows = [];
  dbState.fileRows = [];
  dbState.transactions = 0;
});

test("where a skill's content lives follows from where it came from", () => {
  assertSkillStorageInvariant("registry_github", "object");
  assertSkillStorageInvariant("builtin", "repo_builtin");
  assertSkillStorageInvariant("workspace_custom", "db_text");
  for (const [source, storage] of [
    ["registry_github", "db_text"],
    ["registry_github", "repo_builtin"],
    ["builtin", "object"],
    ["builtin", "db_text"],
    ["workspace_custom", "object"],
    ["workspace_custom", "repo_builtin"],
  ] as const) {
    assert.throws(
      () => assertSkillStorageInvariant(source, storage),
      /storage invariant/,
    );
  }
});

test("buildRegistryUpsertValues describes an object-stored version", () => {
  const bundle = {
    sha256: "b".repeat(64),
    objectKey: `skills/bundles/${"b".repeat(64)}.zip`,
    sizeBytes: 321,
  };
  const values = buildRegistryUpsertValues({
    displayName: "Writer",
    description: "d",
    storagePointer: "github:acme/skills@sha",
    skillMd: SKILL_MD,
    bundle,
    manifestJson: MANIFEST,
    version: "abc123",
    versionStatus: "published",
  });
  assert.equal(values.definition.sourceType, "registry_github");
  assert.equal(values.definition.visibility, "restricted");
  assert.equal(values.version.storageType, "object");
  assert.equal(values.version.isCurrent, true);
  assert.equal(values.version.skillMd, SKILL_MD);
  assert.equal(values.version.bundleSha256, bundle.sha256);
  assert.equal(values.version.bundleObjectKey, bundle.objectKey);
  assert.equal(values.version.bundleSizeBytes, 321);
  // The bundle digest is the version's content identity.
  assert.equal(values.version.contentHash, bundle.sha256);
  // Provenance is still pinned to the immutable commit.
  assert.equal(values.version.storagePointer, "github:acme/skills@sha");
});

test("a new submission stores every file and the bundle, then writes rows that point at them", async () => {
  const result = await upsertRegistrySkillIndex(upsertInput());
  assert.equal(result.status, "indexed");
  assert.equal(result.version, "a".repeat(12));

  // Objects first: not one row is written before the last upload.
  const kinds = dbState.ops
    .filter((op) => op.op !== "select")
    .map((op) => op.op);
  assert.equal(kinds.lastIndexOf("upload"), FILES.length); // 3 blobs + 1 bundle
  assert.ok(kinds.slice(FILES.length + 1).every((op) => op !== "upload"));
  assert.deepEqual(
    dbWrites().map((op) => `${op.op} ${op.table}`),
    [
      "insert skill_definitions",
      "update skill_versions", // demote whatever was current
      "insert skill_versions",
      "insert skill_version_files",
    ],
  );

  // Binary files are blobs like any other, typed as what they are.
  const expected = buildSkillBundleZip(FILES);
  const rows = dbState.fileRows as Array<Record<string, unknown>>;
  assert.deepEqual(
    rows.map((row) => row.path),
    FILES.map((file) => file.path),
  );
  for (const [index, row] of rows.entries()) {
    const file = FILES[index]!;
    const digest = sha256Hex(file.bytes);
    assert.equal(row.contentText, null);
    assert.equal(row.objectKey, `skills/blobs/${digest.slice(0, 2)}/${digest}`);
    assert.equal(row.contentHash, digest);
    assert.equal(row.sizeBytes, file.bytes.byteLength);
    assert.equal(row.mimeType, file.mimeType);
    const object = store.objects.get(row.objectKey as string)!;
    assert.deepEqual(new Uint8Array(object.body), file.bytes);
    assert.equal(object.contentType, file.mimeType);
  }

  const [version] = dbState.versionRows as Array<Record<string, unknown>>;
  assert.equal(version?.storageType, "object");
  assert.equal(version?.skillMd, SKILL_MD);
  assert.equal(version?.bundleSha256, expected.sha256);
  assert.equal(version?.contentHash, expected.sha256);
  assert.equal(
    version?.bundleObjectKey,
    `skills/bundles/${expected.sha256}.zip`,
  );
  assert.equal(version?.bundleSizeBytes, expected.content.byteLength);

  // The bundle is the whole skill, SKILL.md and binaries included.
  const bundle = unzipSync(
    new Uint8Array(store.objects.get(version!.bundleObjectKey as string)!.body),
  );
  assert.deepEqual(Object.keys(bundle).sort(), [
    "SKILL.md",
    "assets/cover.png",
    "fonts/Inter.ttf",
  ]);
  assert.deepEqual(bundle["fonts/Inter.ttf"], TTF);
  assert.deepEqual(bundle["assets/cover.png"], PNG);
});

test("a failed object write leaves the database untouched", async () => {
  for (const failOn of [/skills\/blobs\//, /skills\/bundles\//]) {
    store.failOn = failOn;
    await assert.rejects(
      upsertRegistrySkillIndex(upsertInput()),
      /object storage is down/,
    );
  }
  assert.equal(dbState.transactions, 0);
  assert.deepEqual(dbWrites(), []);
});

test("new versions never delete another version bundle", async () => {
  await upsertRegistrySkillIndex(upsertInput());
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
  assert.equal(dbState.fileRows.length, FILES.length);
  assert.equal(store.uploads.length, FILES.length + 1);
});

test("writing the same source again uploads nothing and returns the stored version", async () => {
  const first = await upsertRegistrySkillIndex(upsertInput());
  const uploads = store.uploads.length;
  dbState.ops = [];
  const again = await upsertRegistrySkillIndex(upsertInput());
  assert.equal(again.skillVersionId, first.skillVersionId);
  assert.equal(again.skillId, first.skillId);
  assert.equal(store.uploads.length, uploads);
  assert.deepEqual(dbWrites(), []);
});

test("the same version label with different bytes is a conflict, not an overwrite", async () => {
  await upsertRegistrySkillIndex(upsertInput());
  dbState.ops = [];
  await assert.rejects(
    upsertRegistrySkillIndex(
      upsertInput({
        files: [
          FILES[0]!,
          { ...FILES[1]!, bytes: new Uint8Array([1, 2, 255]) },
        ],
      }),
    ),
    (error) =>
      error instanceof RegistrySubmissionError &&
      error.code === "REGISTRY_VERSION_CONFLICT",
  );
  assert.deepEqual(dbWrites(), []);
});

test("a version without a commit date is refused before anything is stored", async () => {
  const { committedAt: _dropped, ...registry } = MANIFEST.registry!;
  await assert.rejects(
    upsertRegistrySkillIndex(
      upsertInput({ manifestJson: { ...MANIFEST, registry } }),
    ),
    (error) =>
      error instanceof RegistrySubmissionError &&
      error.code === "REGISTRY_SUBMISSION_UNDATED",
  );
  assert.deepEqual(store.uploads, []);
  assert.equal(dbState.transactions, 0);
});

test("currency follows the commit date, not the order of writes", () => {
  const OLDER = "2026-01-01T00:00:00.000Z";
  const NEWER = "2026-02-01T00:00:00.000Z";
  const takes = (candidate: string | undefined, current?: string | null) =>
    registryVersionTakesCurrent({
      candidateCommittedAt: candidate,
      current: current === null ? null : { committedAt: current },
    });

  // Nothing is current yet: the first published version always is.
  assert.equal(takes(OLDER, null), true);
  // Not older wins; equal dates fall to the newer write.
  assert.equal(takes(NEWER, OLDER), true);
  assert.equal(takes(OLDER, NEWER), false);
  assert.equal(takes(OLDER, OLDER), true);
  // Ingest refuses undated commits, so these do not occur; if one did, it
  // ranks as oldest on whichever side it is — never newest-write-wins.
  assert.equal(takes(undefined, OLDER), false);
  assert.equal(takes("garbage", OLDER), false);
  assert.equal(takes(undefined, undefined), false);
  assert.equal(takes(OLDER, undefined), true);
});
