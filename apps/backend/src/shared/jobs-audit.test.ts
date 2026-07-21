import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  insert: vi.fn(),
  values: vi.fn(),
  onConflictDoUpdate: vi.fn(),
}));

vi.mock("@sourceweft/db", () => ({
  db: {
    insert: mocks.insert,
  },
  jobsAudit: {
    teamId: "team_id",
    idempotencyKey: "idempotency_key",
  },
}));

vi.mock("./config", () => ({
  config: {
    queueName: "sourceweft-jobs",
  },
}));

vi.mock("./logger", () => ({
  logger: {
    warn: vi.fn(),
  },
}));

import { buildAuditInputFromJob, recordJobAudit } from "./jobs-audit";

beforeEach(() => {
  mocks.insert.mockReset();
  mocks.values.mockReset();
  mocks.onConflictDoUpdate.mockReset();
  mocks.insert.mockReturnValue({ values: mocks.values });
  mocks.values.mockReturnValue({
    onConflictDoUpdate: mocks.onConflictDoUpdate,
  });
  mocks.onConflictDoUpdate.mockResolvedValue(undefined);
});

test("recordJobAudit redacts BYOK credentials from the persisted payload", async () => {
  const input = buildAuditInputFromJob({
    jobType: "video-presentation-generate",
    data: {
      teamId: "team-1",
      workspaceId: "workspace-1",
      artifactId: "artifact-1",
      llm: {
        executionMode: "BYOK",
        byokModelId: "model_xyz",
        credentialId: "cred_uvw",
        byok: {
          provider: "openai",
          baseUrl: "https://api.openai.com/v1",
          apiKey: "sk-SECRET-PLAINTEXT-KEY",
          apiKeyRef: "cred-alias",
          defaultHeaders: {
            Authorization: "Bearer SECRET-TOKEN",
            "X-Custom": "safe-value",
          },
        },
      },
    },
    status: "queued",
  });

  await recordJobAudit(input);

  const persisted = mocks.values.mock.calls[0]?.[0]?.payloadJson as Record<
    string,
    unknown
  >;
  const llm = persisted?.llm as Record<string, unknown>;
  const byok = llm?.byok as Record<string, unknown>;
  const headers = byok?.defaultHeaders as Record<string, unknown>;

  // Sensitive fields must be redacted.
  assert.equal(byok?.apiKey, "[REDACTED]");
  assert.equal(byok?.apiKeyRef, "[REDACTED]");
  assert.equal(headers?.Authorization, "[REDACTED]");
  // Non-sensitive fields must be preserved.
  assert.equal(byok?.baseUrl, "https://api.openai.com/v1");
  assert.equal(headers?.["X-Custom"], "safe-value");
  assert.equal(llm?.byokModelId, "model_xyz");
  assert.equal(llm?.credentialId, "cred_uvw");
});

test("recordJobAudit preserves an error summary built from a worker failure", async () => {
  const error = Object.assign(
    new Error("Theme provider returned invalid JSON\nraw"),
    {
      code: "VIDEO_PRESENTATION_THEME_ASSIGNMENT_FAILED",
    },
  );
  const input = buildAuditInputFromJob({
    jobType: "video-presentation-generate",
    data: {
      teamId: "team-1",
      workspaceId: "workspace-1",
      artifactId: "artifact-1",
    },
    status: "failed",
    error,
  });

  await recordJobAudit(input);

  const expectedErrorJson = {
    name: "Error",
    code: "VIDEO_PRESENTATION_THEME_ASSIGNMENT_FAILED",
    message: "Theme provider returned invalid JSON",
  };
  assert.deepEqual(
    mocks.values.mock.calls[0]?.[0]?.errorJson,
    expectedErrorJson,
  );
  assert.deepEqual(
    mocks.onConflictDoUpdate.mock.calls[0]?.[0]?.set?.errorJson,
    expectedErrorJson,
  );
});
