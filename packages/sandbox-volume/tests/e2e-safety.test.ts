import assert from "node:assert/strict";
import { test } from "node:test";
import { testConfiguration } from "./e2e/env";

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
