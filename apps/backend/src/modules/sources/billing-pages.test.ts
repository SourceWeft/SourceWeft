import { test } from "vitest";
import assert from "node:assert/strict";
import {
  estimateSourceTokens,
  resolveBillingPages,
  resolvePhysicalPageCount,
} from "./billing-pages";

test("page-less files use the existing 1000-token standard page rule", () => {
  for (const length of [1, 3999, 4000, 4001, 8000, 12001]) {
    const contentText = "文".repeat(length);
    assert.equal(estimateSourceTokens(contentText), Math.ceil(length / 4));
    assert.equal(
      resolveBillingPages({ contentText }),
      Math.ceil(Math.ceil(length / 4) / 1000),
    );
  }
});

test("physical pages take precedence over text equivalents", () => {
  assert.equal(
    resolveBillingPages({
      physicalPageCount: 2,
      contentText: "x".repeat(80000),
    }),
    2,
  );
  assert.equal(
    resolveBillingPages({ physicalPageCount: 9, contentText: "short" }),
    9,
  );
});

test("only PDF provider evidence and images establish physical pages", () => {
  for (const mimeType of [
    "text/plain",
    "text/csv",
    "application/epub+zip",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "audio/mpeg",
  ]) {
    assert.equal(
      resolvePhysicalPageCount({
        mimeType,
        metadata: {
          pageCount: 1,
          pageCountSource: "pdfjs",
          billingPageCount: 1,
        },
      }),
      undefined,
    );
  }
  assert.equal(resolvePhysicalPageCount({ mimeType: "image/png" }), 1);
  for (const metadata of [
    { pageCount: 3, pageCountSource: "pdfjs" },
    { pageCount: 3, pageCountSource: "ocr" },
    { pageCount: 3, documentParseBackend: "langchain" },
    { pageCount: 3, documentParseBackend: "pdf2markdown" },
  ]) {
    assert.equal(
      resolvePhysicalPageCount({ mimeType: "application/pdf", metadata }),
      3,
    );
  }
  assert.equal(
    resolvePhysicalPageCount({
      mimeType: "application/pdf",
      metadata: {
        pageCount: 1,
        pageCountSource: "unknown",
        documentParseBackend: "pdf2markdown",
      },
    }),
    undefined,
  );
  assert.equal(
    resolvePhysicalPageCount({
      mimeType: "application/pdf",
      metadata: { pageCount: 1 },
    }),
    undefined,
  );
});

test("empty content fails even with physical page claims", () => {
  for (const physicalPageCount of [undefined, 2])
    assert.throws(
      () => resolveBillingPages({ physicalPageCount, contentText: "  " }),
      /Nonempty source content/,
    );
});

test("invalid physical page counts cannot silently change billing basis", () => {
  for (const physicalPageCount of [0, -1, 1.5, NaN, Infinity])
    assert.throws(
      () => resolveBillingPages({ physicalPageCount, contentText: "hello" }),
      /positive safe integer/,
    );
});

for (const pageCountSource of ["pdfjs", "ocr"]) {
  test(`${pageCountSource} invalid declared counts fail instead of changing to text billing`, () => {
    for (const pageCount of [0, -1, 1.5, NaN, Infinity, null, "2"]) {
      assert.throws(
        () =>
          resolvePhysicalPageCount({
            mimeType: "application/pdf",
            metadata: { pageCountSource, pageCount },
          }),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "INVALID_PHYSICAL_PAGE_COUNT",
      );
    }
    const physicalPageCount = resolvePhysicalPageCount({
      mimeType: "application/pdf",
      metadata: { pageCountSource },
    });
    assert.equal(physicalPageCount, undefined);
    assert.equal(
      resolveBillingPages({ physicalPageCount, contentText: "x".repeat(4001) }),
      2,
    );
  });
}
