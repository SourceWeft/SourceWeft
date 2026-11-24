import assert from "node:assert/strict";
import { test } from "vitest";
import {
  describeRefusal,
  type RegistryExistingEntry,
  triageRegistrySubmission,
} from "./guard";

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

test("a scan flag the registry does not know queues for review", () => {
  const decision = triageRegistrySubmission({
    existing: null,
    submitterId: "me",
    scan: { reviewRequired: true, flags: ["something:new"] },
  });
  assert.equal(decision.outcome, "queued");
  assert.ok("versionStatus" in decision);
  assert.equal(decision.versionStatus, "draft");
  assert.deepEqual(decision.reasons, ["something:new"]);
});

test("the attack itself is refused, not queued", () => {
  for (const flag of [
    "egress:pipe-to-shell",
    "egress:base64-exec",
    "injection:override",
  ]) {
    assert.deepEqual(
      triageRegistrySubmission({
        existing: null,
        submitterId: "me",
        scan: { reviewRequired: false, flags: ["tool:sensitive", flag] },
      }),
      { outcome: "refused", reasons: [flag] },
      flag,
    );
  }
});

test("flags that describe what a skill does are published, with the flags kept", () => {
  const decision = triageRegistrySubmission({
    existing: null,
    submitterId: "me",
    scan: {
      reviewRequired: false,
      flags: ["secrets:env-access", "egress:external-post", "tool:sensitive"],
    },
  });
  assert.equal(decision.outcome, "indexed");
  assert.ok("versionStatus" in decision);
  assert.equal(decision.versionStatus, "published");
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
  // A person's decision holds for them exactly as for the owner.
  assert.equal(
    triageRegistrySubmission({
      existing: { ...existing, currentVersionStatus: "disabled" },
      submitterId: "someone-else",
      scan: CLEAN,
    }).outcome,
    "refused",
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

test("a draft is the scan's own hold: a clean later commit answers it", () => {
  const decision = triageRegistrySubmission({
    existing: {
      ownerUserId: "me",
      definitionStatus: "active",
      currentVersionStatus: "draft",
    },
    submitterId: "me",
    scan: CLEAN,
  });
  assert.equal(decision.outcome, "indexed");
});

test("sticky: what an admin took down stays down, and says which", () => {
  for (const [existing, reason] of [
    [
      {
        ownerUserId: "me",
        definitionStatus: "active",
        currentVersionStatus: "deprecated",
      },
      "held:deprecated",
    ],
    [
      {
        ownerUserId: "me",
        definitionStatus: "active",
        currentVersionStatus: "disabled",
      },
      "held:disabled",
    ],
    [
      {
        ownerUserId: "me",
        definitionStatus: "archived",
        currentVersionStatus: "published",
      },
      "held:archived",
    ],
  ] as const) {
    const decision = triageRegistrySubmission({
      existing,
      submitterId: "me",
      scan: CLEAN,
    });
    assert.deepEqual(decision, { outcome: "refused", reasons: [reason] });
    assert.match(
      describeRefusal(decision.reasons),
      new RegExp(reason.slice("held:".length)),
    );
  }
});
