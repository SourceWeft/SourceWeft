import assert from "node:assert/strict";
import test from "node:test";
import { groundedEvidenceSchema } from "../src/grounded-evidence";
import {
  GroundedGenerationError,
  isGroundedGenerationError,
} from "../src/grounded-generation";
import { studyEvidenceSchema } from "../src/study";
import {
  isStudyGenerationError,
  StudyGenerationError,
} from "../src/study-capability";

const baseEvidence = {
  kind: "chunk",
  sourceId: "s",
  documentId: "d",
  chunkId: "c",
  quote: "q",
  quoteHash: `sha256:${"a".repeat(64)}`,
};

test("study evidence is the grounded evidence schema", () => {
  assert.deepEqual(
    studyEvidenceSchema.parse(baseEvidence),
    groundedEvidenceSchema().parse(baseEvidence),
  );
});

test("quote limit is configurable", () => {
  const long = { ...baseEvidence, quote: "x".repeat(301) };
  assert.equal(
    groundedEvidenceSchema({ quoteChars: 300 }).safeParse(long).success,
    false,
  );
  assert.equal(groundedEvidenceSchema().safeParse(long).success, true);
});

test("a study error is recognised as a grounded error and keeps its code", () => {
  const error = new StudyGenerationError("INPUT_TOO_LARGE", "too large");
  assert.equal(isGroundedGenerationError(error), true);
  assert.equal(error.code, "INPUT_TOO_LARGE");
  assert.equal(
    isStudyGenerationError(new GroundedGenerationError("NO_INDEXED_SOURCES", "x")),
    true,
  );
});

test("an error from another module copy is recognised by shape", () => {
  for (const name of ["GroundedGenerationError", "StudyGenerationError"]) {
    const foreign = Object.assign(new Error("x"), {
      name,
      code: "MODEL_UNAVAILABLE",
    });
    assert.equal(isGroundedGenerationError(foreign), true);
  }
  assert.equal(
    isGroundedGenerationError(Object.assign(new Error("x"), { code: "OTHER" })),
    false,
  );
});
