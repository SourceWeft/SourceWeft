import assert from "node:assert/strict";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import { test } from "vitest";
import {
  PresentationSourceV1Schema,
  validatePresentationSourceV1,
} from "./domain/validation";
import {
  basicProductOverviewFixture,
  invalidLayoutSpecFixture,
} from "./__fixtures__";

test("PresentationSourceV1 schema can be represented as JSON Schema", () => {
  const jsonSchema = toJsonSchema(PresentationSourceV1Schema);

  assert.equal((jsonSchema as { type?: unknown }).type, "object");
  assert.doesNotThrow(() => JSON.stringify(jsonSchema));
});

test("PresentationSourceV1 parses basic-product-overview fixture", () => {
  const parsed = validatePresentationSourceV1(basicProductOverviewFixture);

  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.data.schemaVersion, "pptx-composer.v1");
    assert.equal(parsed.data.slides.length, 4);
  }
});

test("PresentationSourceV1 rejects invalid-layoutspec fixture with LAYOUT_SPEC_INVALID", () => {
  const parsed = validatePresentationSourceV1(invalidLayoutSpecFixture);

  assert.equal(parsed.success, false);
  if (!parsed.success) {
    assert.equal(
      parsed.issues.some((issue) => issue.code === "LAYOUT_SPEC_INVALID"),
      true,
    );
  }
});
