import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cleanupE2EContext,
  type E2EContext,
  testConfiguration,
} from "./e2e/env";

const env = {
  SANDBOX_VOLUME_TEST_DATABASE_URL: "postgresql://localhost/test",
  S3_BUCKET: "test-bucket",
  S3_REGION: "auto",
};
test("E2E never treats the application database URL as authorization for tests", () => {
  assert.throws(
    () =>
      testConfiguration({
        DATABASE_URL: "postgresql://production/app",
        S3_BUCKET: "x",
        S3_REGION: "auto",
      }),
    /TEST_DATABASE_URL/,
  );
});
test("object cleanup is constrained to the test namespace", () => {
  for (const prefix of ["", "prod/", "/", "_swvol-e2e/../", "_swvol-e2e"])
    if (prefix)
      assert.throws(
        () => testConfiguration({ ...env, SANDBOX_VOLUME_TEST_PREFIX: prefix }),
        /TEST_PREFIX/,
      );
  assert.equal(testConfiguration(env).prefix, "_swvol-e2e/");
  assert.equal(
    testConfiguration({
      ...env,
      SANDBOX_VOLUME_TEST_PREFIX: "_swvol-e2e/canary/",
    }).prefix,
    "_swvol-e2e/canary/",
  );
});
test("real S3 test configuration must be explicit", () => {
  assert.throws(
    () => testConfiguration({ ...env, S3_BUCKET: "" }),
    /S3_BUCKET/,
  );
  assert.throws(
    () => testConfiguration({ ...env, S3_REGION: "" }),
    /S3_REGION/,
  );
});

test("E2E cleanup closes the database even when provider and S3 deletion fail", async () => {
  const calls: string[] = [];
  const ctx = {
    keyPrefix: "_swvol-e2e/test/",
    store: {
      deletePrefix: async () => {
        calls.push("objects");
        throw new Error("object delete failed");
      },
    },
    close: async () => {
      calls.push("close");
    },
  } as unknown as E2EContext;
  await assert.rejects(
    cleanupE2EContext(ctx, {
      provider: {
        deleteSandbox: async () => {
          calls.push("sandbox");
          throw new Error("provider unavailable");
        },
      },
      sandboxIds: ["created-by-test"],
    }),
    (error) => error instanceof AggregateError && error.errors.length === 2,
  );
  assert.deepEqual(calls, ["sandbox", "objects", "close"]);
});

test("E2E cleanup ignores only authoritative already-missing provider instances", async () => {
  let closed = false;
  const ctx = {
    keyPrefix: "_swvol-e2e/test/",
    store: { deletePrefix: async () => 0 },
    close: async () => {
      closed = true;
    },
  } as unknown as E2EContext;
  await cleanupE2EContext(ctx, {
    provider: {
      deleteSandbox: async () => {
        throw Object.assign(new Error("already gone"), {
          code: "SANDBOX_NOT_FOUND_OR_EXPIRED",
        });
      },
    },
    sandboxIds: ["already-deleted"],
  });
  assert.equal(closed, true);
});
