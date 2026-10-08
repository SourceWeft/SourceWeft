import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  describeMigrationError,
  findMigrationTag,
  MIGRATIONS_FOLDER,
} from "./migrate.mjs";

const blockStatement = readFileSync(
  path.join(MIGRATIONS_FOLDER, "0053_connector_sync_block.sql"),
  "utf8",
)
  .split("--> statement-breakpoint")
  .map((part) => part.trim())
  .find((part) => part.includes('ADD COLUMN "sync_block"'));

test("a failing statement is traced back to its migration", () => {
  assert.ok(blockStatement);
  assert.equal(findMigrationTag(blockStatement), "0053_connector_sync_block");
  assert.equal(
    findMigrationTag(`  ${blockStatement}\n`),
    "0053_connector_sync_block",
  );
  assert.equal(findMigrationTag("SELECT 1"), null);
  assert.equal(findMigrationTag(undefined), null);
});

test("the report carries the database error, its code, and the failing statement", () => {
  // The shape drizzle-orm throws: DrizzleQueryError with the pg error as cause.
  const cause = Object.assign(
    new Error(
      'column "sync_block" of relation "source_connectors" already exists',
    ),
    { code: "42701" },
  );
  const error = Object.assign(new Error(`Failed query: ${blockStatement}`), {
    query: blockStatement,
    cause,
  });
  assert.equal(
    describeMigrationError(error),
    [
      "Schema migration failed.",
      'Error: column "sync_block" of relation "source_connectors" already exists (SQLSTATE 42701)',
      "Migration: 0053_connector_sync_block",
      `Statement: ${blockStatement}`,
      "No migration from this run was applied; the transaction was rolled back.",
    ].join("\n"),
  );
});

test("detail, hint and context are included when the database gives them", () => {
  const cause = Object.assign(new Error('type "vector" does not exist'), {
    code: "42704",
    detail: "some detail",
    hint: "some hint",
    where: "some context",
  });
  const report = describeMigrationError(
    Object.assign(new Error("Failed query"), {
      query: 'CREATE TABLE "x" ("v" vector(3))',
      cause,
    }),
  );
  assert.match(
    report,
    /Error: type "vector" does not exist \(SQLSTATE 42704\)/,
  );
  assert.match(report, /Detail: some detail/);
  assert.match(report, /Hint: some hint/);
  assert.match(report, /Where: some context/);
  assert.doesNotMatch(report, /Migration:/);
});

test("an error outside a query, such as a refused connection, is still reported", () => {
  const report = describeMigrationError(
    Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), {
      code: "ECONNREFUSED",
    }),
  );
  assert.match(
    report,
    /Error: connect ECONNREFUSED 127\.0\.0\.1:5432 \(SQLSTATE ECONNREFUSED\)/,
  );
  assert.doesNotMatch(report, /Statement:/);
});

test("merged feature migrations have unique numbers and increasing ledger timestamps", () => {
  const journal = JSON.parse(
    readFileSync(path.join(MIGRATIONS_FOLDER, "meta/_journal.json"), "utf8"),
  );
  const entries = journal.entries;
  const files = readdirSync(MIGRATIONS_FOLDER).filter((name) =>
    /^\d{4}_.+\.sql$/.test(name),
  );
  for (let index = 0; index < entries.length; index++) {
    assert.equal(entries[index].idx, index);
    assert.ok(files.includes(`${entries[index].tag}.sql`));
    // Preserve published historical timestamps; only this merged sequence is newly ordered.
    if (index >= 62)
      assert.ok(
        entries[index].when > entries[index - 1].when,
        `migration ${entries[index].tag} must run after ${entries[index - 1].tag}`,
      );
  }
  assert.equal(entries[60].tag, "0060_skill_source_identity");
  assert.equal(entries[61].tag, "0061_skill_install_references");
  for (let index = 60; index <= 67; index++) {
    const prefix = String(index).padStart(4, "0") + "_";
    assert.equal(
      files.filter((name) => name.startsWith(prefix)).length,
      1,
      `ambiguous migration number ${prefix}`,
    );
  }
});

test("each volume snapshot retains main skill identity and links to its immediate predecessor", () => {
  const snapshot = (index) =>
    JSON.parse(
      readFileSync(
        path.join(
          MIGRATIONS_FOLDER,
          `meta/${String(index).padStart(4, "0")}_snapshot.json`,
        ),
        "utf8",
      ),
    );
  const main = snapshot(61);
  const nonVolume = (tables) =>
    Object.fromEntries(
      Object.entries(tables).filter(
        ([name]) => !name.startsWith("public.sandbox_volume"),
      ),
    );
  assert.ok(
    main.tables["public.skill_definitions"].columns.github_repository_id,
  );
  assert.ok(main.tables["public.skill_definitions"].columns.source_root);
  assert.ok(
    main.tables["public.skill_definitions"].indexes
      .skill_definitions_github_source_uq,
  );
  assert.ok(main.tables["public.skill_definitions"].columns.install_ref);
  assert.ok(
    main.tables["public.skill_definitions"].indexes
      .skill_definitions_install_ref_uq,
  );
  const expectedVolumes = [7, 8, 9, 9, 11, 12];
  const ids = new Set([main.id]);
  let previous = main;
  for (let index = 62; index <= 67; index++) {
    const current = snapshot(index);
    assert.equal(
      current.prevId,
      previous.id,
      `broken snapshot ancestry at ${index}`,
    );
    assert.equal(
      ids.has(current.id),
      false,
      `reused snapshot identity at ${index}`,
    );
    ids.add(current.id);
    assert.deepEqual(
      nonVolume(current.tables),
      nonVolume(main.tables),
      `main schema lost in volume snapshot ${index}`,
    );
    assert.equal(
      Object.keys(current.tables).filter((name) =>
        name.startsWith("public.sandbox_volume"),
      ).length,
      expectedVolumes[index - 62],
    );
    for (const key of [
      "enums",
      "schemas",
      "sequences",
      "roles",
      "policies",
      "views",
      "_meta",
    ])
      assert.deepEqual(current[key], main[key]);
    previous = current;
  }
});
