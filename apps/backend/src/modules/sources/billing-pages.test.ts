import { test } from "vitest";
import assert from "node:assert/strict";
import { ContentError } from "../content/errors";
import { resolveBillingPages } from "./billing-pages";

test("resolveBillingPages uses explicit parsed or estimated page counts", () => {
  assert.equal(
    resolveBillingPages({ parsedPages: 2, contentText: "hello" }),
    2,
  );
  assert.equal(resolveBillingPages({ estimatedPages: 1.2 }), 2);
  assert.equal(resolveBillingPages({ sourceEstimatedPages: 3 }), 3);
});

test("resolveBillingPages falls back to one page for indexable content", () => {
  assert.equal(resolveBillingPages({ chunkCount: 1 }), 1);
  assert.equal(resolveBillingPages({ contentText: "manual source text" }), 1);
});

test("resolveBillingPages rejects empty content without any page signal", () => {
  assert.throws(
    () => resolveBillingPages({ contentText: "   ", chunkCount: 0 }),
    (error) =>
      error instanceof ContentError &&
      error.code === "INGESTION_PAGE_COUNT_MISSING",
  );
});
