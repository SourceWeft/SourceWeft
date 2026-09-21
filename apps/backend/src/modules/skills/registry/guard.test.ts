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

test("another submitter's clean commit of the same repository indexes", () => {
  // No ownership veto: the content is the upstream's, from its default
  // branch, whoever submits it. Control of the listing is not decided here.
  const existing: RegistryExistingEntry = {
    ownerUserId: "first-importer",
    definitionStatus: "active",
    currentVersionStatus: "published",
  };
  assert.deepEqual(
    triageRegistrySubmission({
      existing,
      submitterId: "someone-else",
      scan: CLEAN,
    }),
    {
      outcome: "indexed",
      versionStatus: "published",
      definitionStatus: "active",
      reasons: [],
    },
  );
  // Sticky review holds for them exactly as for the owner.
  assert.equal(
    triageRegistrySubmission({
      existing: { ...existing, currentVersionStatus: "draft" },
      submitterId: "someone-else",
      scan: CLEAN,
    }).outcome,
    "queued",
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
