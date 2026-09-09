import assert from "node:assert/strict";
import { test } from "vitest";
import { RegistrySubmissionError } from "./errors";
import { type RegistryExistingEntry, triageRegistrySubmission } from "./guard";

const CLEAN = { reviewRequired: false, flags: [] as string[] };

test("clean + new → indexed / published", () => {
  const decision = triageRegistrySubmission({
    existing: null,
    submitterId: "me",
    scan: CLEAN,
  });
  assert.equal(decision.outcome, "indexed");
  assert.equal(decision.versionStatus, "published");
  assert.equal(decision.definitionStatus, "active");
});

test("a flagged scan queues for review", () => {
  const decision = triageRegistrySubmission({
    existing: null,
    submitterId: "me",
    scan: { reviewRequired: true, flags: ["egress:pipe-to-shell"] },
  });
  assert.equal(decision.outcome, "queued");
  assert.equal(decision.versionStatus, "draft");
  assert.ok(decision.reasons.includes("egress:pipe-to-shell"));
});

test("ownership: a different submitter cannot overwrite an existing entry", () => {
  const existing: RegistryExistingEntry = {
    ownerUserId: "victim",
    definitionStatus: "active",
    currentVersionStatus: "published",
  };
  assert.throws(
    () =>
      triageRegistrySubmission({
        existing,
        submitterId: "attacker",
        scan: CLEAN,
      }),
    (error) =>
      error instanceof RegistrySubmissionError &&
      error.code === "REGISTRY_SUBMISSION_CONFLICT",
  );
});

test("the owner may re-submit their own clean entry and re-index", () => {
  const existing: RegistryExistingEntry = {
    ownerUserId: "me",
    definitionStatus: "active",
    currentVersionStatus: "published",
  };
  const decision = triageRegistrySubmission({
    existing,
    submitterId: "me",
    scan: CLEAN,
  });
  assert.equal(decision.outcome, "indexed");
});

test("sticky: an in-review (draft) entry cannot auto-index on a clean re-submit", () => {
  const existing: RegistryExistingEntry = {
    ownerUserId: "me",
    definitionStatus: "active",
    currentVersionStatus: "draft",
  };
  const decision = triageRegistrySubmission({
    existing,
    submitterId: "me",
    scan: CLEAN,
  });
  assert.equal(decision.outcome, "queued");
  assert.ok(decision.reasons.includes("sticky-review"));
});

test("sticky: a deprecated version or archived definition stays queued", () => {
  for (const existing of [
    {
      ownerUserId: "me",
      definitionStatus: "active",
      currentVersionStatus: "deprecated",
    },
    {
      ownerUserId: "me",
      definitionStatus: "archived",
      currentVersionStatus: "published",
    },
  ] as const) {
    const decision = triageRegistrySubmission({
      existing,
      submitterId: "me",
      scan: CLEAN,
    });
    assert.equal(decision.outcome, "queued");
  }
});
