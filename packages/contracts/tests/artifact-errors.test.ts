import assert from "node:assert/strict";
import test from "node:test";

import {
  ARTIFACT_ERROR_CATEGORIES,
  ARTIFACT_ERROR_CATEGORY_BY_CODE,
  ARTIFACT_WRITE_ERROR_CODES,
  ArtifactError,
  classifyArtifactErrorCode,
  isArtifactError,
  isRecoverableArtifactErrorCategory,
  isRecoverableArtifactErrorCode,
  toArtifactError,
} from "../src/artifact-errors";

/**
 * These tests pin the two properties the module exists for.
 *
 * 1. Every legacy code keeps its spelling. The codes are a wire contract —
 *    clients and stored artifact rows branch on them — so the table may gain
 *    rows but must never rename one. The explicit list below is what a rename
 *    would have to walk past.
 * 2. `recoverable` is derived, never restated. That is the drift that produced
 *    separate schemes with conflicting answers to the same question.
 */

/* ========================================================================== */
/* 1. The wire contract                                                       */
/* ========================================================================== */

test("classification covers every code the generic artifact schemes raise", () => {
  const publishArtifactCodes = [
    "PUBLISH_INPUT_INVALID",
    "ARTIFACT_TYPE_UNSUPPORTED",
    "ARTIFACT_SOURCE_UNAVAILABLE",
    "ARTIFACT_SOURCE_NOT_FOUND",
    "ARTIFACT_SOURCE_INVALID",
    "ARTIFACT_STORAGE_UNAVAILABLE",
    "ARTIFACT_RECORD_UNAVAILABLE",
    "ARTIFACT_FILE_EMPTY",
    "ARTIFACT_FILE_TOO_LARGE",
    "ARTIFACT_PREVIEW_IMAGE_INVALID",
    "ARTIFACT_PREVIEW_IMAGE_TOO_LARGE",
    "PPTX_OUTPUT_NOT_FOUND",
    "PPTX_OUTPUT_TOO_LARGE",
    "PPTX_OUTPUT_INVALID_EXTENSION",
    "PPTX_OUTPUT_INVALID_MIME",
    "PPTX_PACKAGE_INVALID",
    "SANDBOX_UNAVAILABLE",
    "PPTX_SOURCE_UNSUPPORTED",
  ];
  for (const code of [...publishArtifactCodes, "DELIVERABLE_JOB_FAILED"]) {
    assert.ok(
      code in ARTIFACT_ERROR_CATEGORY_BY_CODE,
      `${code} lost its classification`,
    );
  }
});

test("the publish-artifact recoverability split is reproduced exactly", () => {
  // isRecoverableArtifactPublishErrorCode called exactly these three
  // unrecoverable, and everything else recoverable.
  const unrecoverable = [
    "ARTIFACT_STORAGE_UNAVAILABLE",
    "ARTIFACT_RECORD_UNAVAILABLE",
    "SANDBOX_UNAVAILABLE",
  ];
  for (const code of unrecoverable) {
    assert.equal(classifyArtifactErrorCode(code), "infrastructure");
    assert.equal(isRecoverableArtifactErrorCode(code), false);
  }
  assert.equal(isRecoverableArtifactErrorCode("PUBLISH_INPUT_INVALID"), true);
  assert.equal(isRecoverableArtifactErrorCode("PPTX_PACKAGE_INVALID"), true);
});

test("the two codes for an empty publish are classed the same, not renamed", () => {
  // Slides say PPTX_PACKAGE_INVALID, files say ARTIFACT_FILE_EMPTY, for one
  // situation. Renaming either breaks a client, so only the class is unified.
  assert.equal(
    classifyArtifactErrorCode("PPTX_PACKAGE_INVALID"),
    classifyArtifactErrorCode("ARTIFACT_FILE_EMPTY"),
  );
});

test("every classification names a real category", () => {
  for (const [code, category] of Object.entries(
    ARTIFACT_ERROR_CATEGORY_BY_CODE,
  )) {
    assert.ok(
      (ARTIFACT_ERROR_CATEGORIES as readonly string[]).includes(category),
      `${code} -> ${category}`,
    );
  }
});

test("every writer code is classified", () => {
  for (const code of Object.values(ARTIFACT_WRITE_ERROR_CODES)) {
    assert.ok(code in ARTIFACT_ERROR_CATEGORY_BY_CODE, code);
  }
});

/* ========================================================================== */
/* 2. Recoverability is derived                                               */
/* ========================================================================== */

test("only validation is recoverable", () => {
  assert.equal(isRecoverableArtifactErrorCategory("validation"), true);
  assert.equal(isRecoverableArtifactErrorCategory("infrastructure"), false);
  // A conflict means someone else owns the outcome; a blind retry is wrong.
  assert.equal(isRecoverableArtifactErrorCategory("conflict"), false);
});

test("ArtifactError derives recoverable from category, not from the caller", () => {
  const infra = new ArtifactError({ code: "ARTIFACT_STORAGE_UNAVAILABLE" });
  assert.equal(infra.category, "infrastructure");
  assert.equal(infra.recoverable, false);

  const conflict = new ArtifactError({ code: "ARTIFACT_STATE_CONFLICT" });
  assert.equal(conflict.recoverable, false);

  // An explicit category wins over the table, for codes a handler owns.
  const owned = new ArtifactError({
    code: "SOME_CAPABILITY_CODE",
    category: "infrastructure",
  });
  assert.equal(owned.recoverable, false);
});

test("an unknown code falls back to validation unless told otherwise", () => {
  assert.equal(classifyArtifactErrorCode("NOPE"), "validation");
  assert.equal(
    classifyArtifactErrorCode("NOPE", "infrastructure"),
    "infrastructure",
  );
});

/* ========================================================================== */
/* 3. Normalizing across the module boundary                                  */
/* ========================================================================== */

test("isArtifactError is structural, so it survives a separate module graph", () => {
  const foreign = Object.assign(new Error("boom"), {
    code: "ARTIFACT_STATE_CONFLICT",
    category: "conflict",
    recoverable: false,
  });
  assert.equal(isArtifactError(foreign), true);
  assert.equal(toArtifactError(foreign), foreign);
});

test("a bare Error keeps its message and takes the fallback code", () => {
  const normalized = toArtifactError(new Error("provider returned no bytes"));
  assert.equal(normalized.message, "provider returned no bytes");
  assert.equal(normalized.code, ARTIFACT_WRITE_ERROR_CODES.recordUnavailable);
  assert.equal(normalized.recoverable, false);
  assert.equal(normalized.cause instanceof Error, true);
});

test("an error already carrying a code keeps it", () => {
  const withCode = Object.assign(new Error("nope"), {
    code: "SANDBOX_UNAVAILABLE",
  });
  const normalized = toArtifactError(withCode);
  assert.equal(normalized.code, "SANDBOX_UNAVAILABLE");
  assert.equal(normalized.category, "infrastructure");
});

test("a non-Error throw is still normalized", () => {
  const normalized = toArtifactError("just a string", "SANDBOX_UNAVAILABLE");
  assert.equal(normalized.code, "SANDBOX_UNAVAILABLE");
  assert.equal(normalized.message, "just a string");
});
