import assert from "node:assert/strict";
import test from "node:test";

import { ARTIFACT_WRITE_ERROR_CODES } from "../src/artifact-errors";
import {
  artifactErrorFromIssues,
  attachmentRole,
  primaryArtifactAttachment,
  validateArtifactPublishSpec,
  type ArtifactAttachment,
  type ArtifactPublishSpec,
} from "../src/artifact-write";

const bytes = (length: number) => new Uint8Array(length);

function spec(overrides: Partial<ArtifactPublishSpec> = {}): ArtifactPublishSpec {
  return {
    artifactType: "image",
    title: "A title",
    payload: { prompt: "a cat" },
    ...overrides,
  };
}

function attachment(
  overrides: Partial<ArtifactAttachment> = {},
): ArtifactAttachment {
  return {
    fileName: "image.png",
    contentType: "image/png",
    bytes: bytes(8),
    ...overrides,
  };
}

/* ========================================================================== */
/* 1. The model: payload is required, bytes are not                           */
/* ========================================================================== */

test("a payload-only artifact is valid — no attachment required", () => {
  // This is the case the old file-centric write path could not express at all,
  // which is why video_presentation grew its own.
  assert.deepEqual(
    validateArtifactPublishSpec(
      spec({ artifactType: "video_presentation", attachments: [] }),
    ),
    [],
  );
});

test("a missing title or payload is rejected", () => {
  const issues = validateArtifactPublishSpec(
    spec({ title: "  ", payload: undefined as never }),
  );
  assert.deepEqual(
    issues.map((issue) => issue.field),
    ["title", "payload"],
  );
  for (const issue of issues) {
    assert.equal(issue.code, ARTIFACT_WRITE_ERROR_CODES.payloadInvalid);
  }
});

test("an array is not a payload", () => {
  const issues = validateArtifactPublishSpec(
    spec({ payload: [] as unknown as Record<string, unknown> }),
  );
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.field, "payload");
});

/* ========================================================================== */
/* 2. Attachments                                                             */
/* ========================================================================== */

test("attachments default to the asset role; at most one may be primary", () => {
  assert.equal(attachmentRole(attachment()), "asset");
  assert.equal(attachmentRole(attachment({ role: "primary" })), "primary");

  const twoPrimaries = validateArtifactPublishSpec(
    spec({
      attachments: [
        attachment({ fileName: "a.png", role: "primary" }),
        attachment({ fileName: "b.png", role: "primary" }),
      ],
    }),
  );
  assert.equal(twoPrimaries.length, 1);
  assert.match(twoPrimaries[0]!.message, /at most 1 attachment/);
});

test("primaryArtifactAttachment finds the row's own stored file", () => {
  const primary = attachment({ fileName: "deck.pptx", role: "primary" });
  assert.equal(
    primaryArtifactAttachment(
      spec({ attachments: [attachment({ fileName: "thumb.png" }), primary] }),
    ),
    primary,
  );
  assert.equal(primaryArtifactAttachment(spec()), null);
});

test("an empty attachment is rejected before any byte is uploaded", () => {
  const issues = validateArtifactPublishSpec(
    spec({ attachments: [attachment({ bytes: bytes(0) })] }),
  );
  assert.equal(issues[0]?.code, ARTIFACT_WRITE_ERROR_CODES.attachmentEmpty);
});

test("an attachment over its own ceiling is rejected", () => {
  const issues = validateArtifactPublishSpec(
    spec({ attachments: [attachment({ bytes: bytes(9), maxBytes: 8 })] }),
  );
  assert.equal(issues[0]?.code, ARTIFACT_WRITE_ERROR_CODES.attachmentTooLarge);
});

test("no ceiling means no size check — the host invents no per-type number", () => {
  assert.deepEqual(
    validateArtifactPublishSpec(
      spec({ attachments: [attachment({ bytes: bytes(1_000_000) })] }),
    ),
    [],
  );
});

test("duplicate file names are rejected — resolveAsset could only reach one", () => {
  const issues = validateArtifactPublishSpec(
    spec({
      attachments: [
        attachment({ fileName: "a.png" }),
        attachment({ fileName: "a.png" }),
      ],
    }),
  );
  assert.equal(issues.length, 1);
  assert.match(issues[0]!.message, /duplicate attachment fileName/);
});

test("every problem with one spec is reported in one pass", () => {
  const issues = validateArtifactPublishSpec(
    spec({
      title: "",
      attachments: [
        attachment({ fileName: "", bytes: bytes(0) }),
        attachment({ bytes: bytes(9), maxBytes: 1 }),
      ],
    }),
  );
  assert.equal(issues.length, 4);
});

/* ========================================================================== */
/* 4. Issues collapse into the one error vocabulary                           */
/* ========================================================================== */

test("no issues is not an error", () => {
  assert.equal(artifactErrorFromIssues([]), null);
});

test("the reported code comes from the least recoverable issue", () => {
  // Reporting "fix your input" when one of the problems is a dead dependency
  // sends an agent into a retry loop against the dependency.
  const error = artifactErrorFromIssues([
    { code: ARTIFACT_WRITE_ERROR_CODES.payloadInvalid, message: "bad title" },
    {
      code: "SANDBOX_UNAVAILABLE",
      category: "infrastructure",
      message: "sandbox is down",
    },
  ]);
  assert.equal(error?.code, "SANDBOX_UNAVAILABLE");
  assert.equal(error?.recoverable, false);
  // The message still carries every issue.
  assert.match(error!.message, /bad title/);
  assert.match(error!.message, /sandbox is down/);
});

test("fields are prefixed onto the message so the caller can find them", () => {
  const error = artifactErrorFromIssues([
    { code: "X", field: "payload.slides", message: "must not be empty" },
  ]);
  assert.equal(error?.message, "payload.slides: must not be empty");
  assert.equal(error?.details, "payload.slides");
});

test("a validation-only failure stays recoverable", () => {
  const error = artifactErrorFromIssues(
    validateArtifactPublishSpec(spec({ title: "" })),
  );
  assert.equal(error?.code, ARTIFACT_WRITE_ERROR_CODES.payloadInvalid);
  assert.equal(error?.recoverable, true);
});
