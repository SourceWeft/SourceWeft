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
