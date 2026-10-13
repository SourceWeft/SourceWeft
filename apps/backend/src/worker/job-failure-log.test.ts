import { test } from "vitest";
import assert from "node:assert/strict";
import { ConnectorError } from "../modules/connectors/errors";
import { ContentError } from "../modules/content/errors";
import { buildWorkerJobFailureLog } from "./job-failure-log";

test("worker job failure log includes source parse payload and content error details", () => {
  const log = buildWorkerJobFailureLog(
    {
      id: "source_parse_source-1_1",
      name: "source-parse",
      attemptsMade: 1,
      opts: { attempts: 3 },
      data: {
        sourceId: "source-1",
        sourceRevisionId: "revision-1",
        workspaceId: "workspace-1",
        teamId: "team-1",
        userId: "user-1",
        idempotencyKey: "source_parse_source-1_1",
        forceRefresh: true,
      },
    } as never,
    new ContentError(
      400,
      "SOURCE_STORAGE_MISSING",
      "Source file storage is incomplete",
    ),
  );

  assert.equal(log.jobId, "source_parse_source-1_1");
  assert.equal(log.type, "source-parse");
  assert.equal(log.errorCode, "SOURCE_STORAGE_MISSING");
  assert.equal(log.errorStatusCode, 400);
  assert.deepEqual(log.payload, {
    sourceId: "source-1",
    sourceRevisionId: "revision-1",
    workspaceId: "workspace-1",
    teamId: "team-1",
    userId: "user-1",
    idempotencyKey: "source_parse_source-1_1",
    forceRefresh: true,
  });
});

test("worker job failure log includes connector error details", () => {
  const log = buildWorkerJobFailureLog(
    {
      id: "thread-chat-run-1",
      name: "thread-chat-run",
      attemptsMade: 1,
      opts: { attempts: 1 },
      data: {
        runId: "run-1",
        workspaceId: "workspace-1",
        teamId: "team-1",
      },
    } as never,
    new ConnectorError(
      400,
      "CONNECTOR_SCHEMA_VALIDATION_FAILED",
      "requestJson.parentPageId must be string",
    ),
  );

  assert.equal(log.errorCode, "CONNECTOR_SCHEMA_VALIDATION_FAILED");
  assert.equal(log.errorStatusCode, 400);
});

test("a failed database query is logged by its SQL head and parameter count, never the parameter values", () => {
  // The shape of drizzle's DrizzleQueryError: `message` carries the SQL and
  // every bound parameter, which for a 7,500-file bundle insert ran to several
  // megabytes per attempt.
  const params = Array.from({ length: 100_000 }, (_, i) => `param-value-${i}`);
  const query = `insert into "skill_version_files" (${"col, ".repeat(400)}) values (${params.map(() => "?").join(", ")})`;
  const error = new Error(
    `Failed query: ${query}\nparams: ${params.join(",")}`,
  );
  error.name = "DrizzleQueryError";
  Object.assign(error, {
    query,
    params,
    cause: new Error(
      "bind message supplies 100000 parameters, but prepared statement requires 65535",
    ),
  });
  error.stack = `${error.name}: ${error.message}\n    at run (repository.ts:1:1)`;

  const log = buildWorkerJobFailureLog(
    {
      id: "skill-registry-ingest-1",
      name: "skill-registry-ingest",
      attemptsMade: 1,
      opts: { attempts: 3 },
      data: { submissionId: "sub_1" },
    } as never,
    error,
  );

  const message = log.error as string;
  const stack = log.stack as string;
  assert.ok(message.length < 4096, `error field is ${message.length} chars`);
  assert.ok(stack.length < 4096, `stack field is ${stack.length} chars`);
  assert.ok(
    message.startsWith('Failed query: insert into "skill_version_files"'),
  );
  assert.ok(message.includes("(100000 params)"));
  assert.ok(message.includes("bind message supplies 100000 parameters"));
  assert.ok(!message.includes("param-value-"));
  assert.ok(!stack.includes("param-value-"));
  assert.equal(log.errorName, "DrizzleQueryError");
});

test("an ordinary oversized error message and stack are capped", () => {
  const error = new Error("x".repeat(10_000));
  error.stack = `Error: ${"y".repeat(10_000)}\n    at somewhere`;
  const log = buildWorkerJobFailureLog(undefined, error);
  const message = log.error as string;
  const stack = log.stack as string;
  assert.ok(
    message.length <= 4096 + 40,
    `error field is ${message.length} chars`,
  );
  assert.ok(message.startsWith("x".repeat(4096)));
  assert.ok(message.endsWith("…[truncated 5904 chars]"));
  assert.ok(stack.length <= 4096 + 40, `stack field is ${stack.length} chars`);
  assert.match(stack, /…\[truncated \d+ chars\]$/);
});

test("a short error message and stack are logged untouched", () => {
  const error = new Error("boom");
  const log = buildWorkerJobFailureLog(undefined, error);
  assert.equal(log.error, "boom");
  assert.equal(log.stack, error.stack);
});
