import assert from "node:assert/strict";
import { test } from "vitest";
import { groundedRequestArtifactStatus } from "./request-key";

test("a new request's artifact is pending whatever its row says", () => {
  assert.equal(groundedRequestArtifactStatus(false, "ready"), "pending");
  assert.equal(groundedRequestArtifactStatus(false, undefined), "pending");
});

test("a reused artifact reports where it stands", () => {
  assert.equal(groundedRequestArtifactStatus(true, "ready"), "ready");
  assert.equal(groundedRequestArtifactStatus(true, "running"), "running");
  assert.equal(groundedRequestArtifactStatus(true, "pending"), "pending");
});

test("a reused row read in a race with a failure, or missing, counts as pending", () => {
  assert.equal(groundedRequestArtifactStatus(true, "failed"), "pending");
  assert.equal(groundedRequestArtifactStatus(true, null), "pending");
});
