import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
