import assert from "node:assert/strict";
import { test } from "vitest";
import { RegistrySubmissionError } from "../errors";
import { describeIngestError, INGEST_FAILED_CODE } from "./errors";

/**
 * What a submission row records of an error it cannot name. The row is read
 * back by every poll of the submission, so it must never carry a failed
 * statement's parameters (a drizzle query error's message does).
 */

test("an error with a code of its own is recorded as is", () => {
  const described = describeIngestError(
    new RegistrySubmissionError("REGISTRY_SUBMISSION_TOO_LARGE", "too large"),
  );
  assert.deepEqual(described, {
    code: "REGISTRY_SUBMISSION_TOO_LARGE",
    message: "too large",
  });
});

test("a failed database query is recorded by its SQL head and parameter count", () => {
  const params = Array.from({ length: 67_743 }, (_, i) => `value-${i}`);
  const query = `insert into "skill_version_files" ("id", "path") values ${params.map(() => "($1, $2)").join(", ")}`;
  const error = new Error(
    `Failed query: ${query}\nparams: ${params.join(",")}`,
  );
  error.name = "DrizzleQueryError";
  Object.assign(error, { query, params, cause: new Error("too many params") });

  const described = describeIngestError(error);
  assert.equal(described.code, INGEST_FAILED_CODE);
  assert.ok(described.message.length < 4096, `${described.message.length}`);
  assert.ok(
    described.message.startsWith(
      'Failed query: insert into "skill_version_files"',
    ),
  );
  assert.ok(described.message.includes("(67743 params)"));
  assert.ok(described.message.includes("too many params"));
  assert.ok(!described.message.includes("value-"));
});

test("an oversized fallback message is capped", () => {
  const described = describeIngestError(new Error("z".repeat(20_000)));
  assert.equal(described.code, INGEST_FAILED_CODE);
  assert.ok(described.message.startsWith("z".repeat(4096)));
  assert.ok(described.message.endsWith("…[truncated 15904 chars]"));
  assert.ok(described.message.length < 4200);
});
