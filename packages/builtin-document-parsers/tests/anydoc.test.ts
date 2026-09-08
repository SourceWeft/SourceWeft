import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { csvSourceParser } from "../src/csv";
import { epubSourceParser } from "../src/epub";
import { readPdfPageCount } from "../src/pdf-page-count";
import { buildParsedDocument } from "../src/build-parsed-document";
import {
  isAnydocMimeType,
  isAnydocNeedsOcrError,
  parseWithAnydoc,
} from "../src/anydoc";
import type { ParseInput } from "../src/types";

async function fixture(
  fileName: string,
  mimeType: string,
): Promise<ParseInput> {
  const content = await readFile(
    new URL(`./fixtures/anydoc/${fileName}`, import.meta.url),
  );
  return {
    fileName,
    mimeType,
    fileSize: content.length,
    content,
    config: { chunkSize: 512, parserVersion: "anydoc-v1" },
  };
}

for (const [name, mime, expected] of [
  [
    "sample.docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ["SourceWeft", "中文测试", "1234.56"],
  ],
  [
    "sample.pptx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ["SourceWeft slide 42"],
  ],
  ["sample.epub", "application/epub+zip", ["SourceWeft chapter", "9876"]],
  ["sample.csv", "text/csv", ["中文", "1234.56", "SourceWeft"]],
  ["sample.csv", "application/csv", ["中文", "1234.56", "SourceWeft"]],
  [
    "text.pdf",
    "application/pdf",
    ["First page", "1234", "Second page", "5678"],
  ],
] as const) {
  test(`native AnyDoc parses ${name} through normalized document and chunk output`, async () => {
    const result = await parseWithAnydoc(await fixture(name, mime));
    for (const fragment of expected)
      assert.ok(
        result.content.includes(fragment),
        `Missing ${fragment}: ${result.content}`,
      );
    assert.ok(result.chunks.length > 0);
    assert.equal(result.metadata.parserEngineVersion, "0.2.4");
    assert.equal(result.metadata.detectedFormat, name.split(".").at(-1));
    assert.deepEqual(result.pages, []);
    assert.equal(result.metadata.pageLocationAvailable, false);
    assert.equal(
      result.metadata.pageCount,
      name === "text.pdf" ? 2 : undefined,
    );
    assert.equal(
      result.metadata.pageCountSource,
      name === "text.pdf" ? "pdfjs" : undefined,
    );
  });
}

test("native image-only PDF emits typed OCR requirement without a hosted request", async () => {
  await assert.rejects(
    () => parseWithAnydocInput("scan.pdf"),
    (error: unknown) => {
      assert.ok(isAnydocNeedsOcrError(error));
      assert.equal(error.pageCount, 2);
      assert.deepEqual(error.pages, [1, 2]);
      return true;
    },
  );
});

async function parseWithAnydocInput(name: string) {
  return parseWithAnydoc(await fixture(name, "application/pdf"));
}

test("malformed, empty, and mismatched files do not become OCR requirements", async () => {
  const input = await fixture("text.pdf", "application/pdf");
  for (const changed of [
    { ...input, content: Buffer.from("%PDF-1.4\ninvalid"), fileSize: 16 },
    { ...input, content: Buffer.alloc(0), fileSize: 0 },
    { ...input, mimeType: "text/csv" },
  ]) {
    await assert.rejects(
      () => parseWithAnydoc(changed),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(isAnydocNeedsOcrError(error), false);
        return true;
      },
    );
  }
  assert.equal(isAnydocNeedsOcrError(new Error("needsOcr")), false);
  assert.equal(isAnydocNeedsOcrError({ code: "needsOcr" }), false);
});

test("unvalidated formats are not advertised", () => {
  assert.equal(isAnydocMimeType("image/png"), false);
  assert.equal(isAnydocMimeType("application/msword"), false);
  assert.equal(
    isAnydocMimeType(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ),
    false,
  );
});

test("explicit unknown page locations do not acquire synthetic page one", async () => {
  const parseInput = await fixture("text.pdf", "application/pdf");
  const result = await buildParsedDocument({
    parseInput,
    content: "Multiple pages without positions",
    pages: [],
    metadata: { pageCount: undefined },
  });
  assert.deepEqual(result.pages, []);
  assert.equal(result.metadata.pageCount, undefined);
  const legacy = await buildParsedDocument({
    parseInput,
    content: "Legacy logical section",
  });
  assert.equal(legacy.pages[0]?.pageNumber, 1);
});

test("hybrid PDF requires OCR for the whole input instead of returning partial text", async () => {
  await assert.rejects(
    () => parseWithAnydocInput("hybrid.pdf"),
    (error: unknown) => {
      assert.ok(isAnydocNeedsOcrError(error));
      assert.equal(error.pageCount, 2);
      assert.deepEqual(error.pages, [1]);
      return true;
    },
  );
});

test("reject mode never calls hosted fetch even when ambient Firecrawl credentials exist", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests += 1;
    throw new Error("Hosted upload is forbidden in local parsing");
  });
  const originalKey = process.env.FIRECRAWL_API_KEY;
  const originalUrl = process.env.FIRECRAWL_API_URL;
  process.env.FIRECRAWL_API_KEY = "test-key-must-not-be-used";
  process.env.FIRECRAWL_API_URL = "https://example.invalid";
  try {
    await assert.rejects(
      () => parseWithAnydocInput("scan.pdf"),
      isAnydocNeedsOcrError,
    );
    assert.equal(requests, 0);
  } finally {
    if (originalKey === undefined) delete process.env.FIRECRAWL_API_KEY;
    else process.env.FIRECRAWL_API_KEY = originalKey;
    if (originalUrl === undefined) delete process.env.FIRECRAWL_API_URL;
    else process.env.FIRECRAWL_API_URL = originalUrl;
  }
});

test("PDF page-count metadata rejects invalid input instead of estimating", async () => {
  await assert.rejects(() => readPdfPageCount(Buffer.from("not a PDF")));
  const input = await fixture("text.pdf", "application/pdf");
  assert.equal(await readPdfPageCount(input.content), 2);
});

test("importing legacy parser entry does not load AnyDoc or its native bindings", () => {
  const output = execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
    import { createRequire } from "node:module";
    const require = createRequire(import.meta.url);
    const { textSourceParser } = await import("./src/index.ts");
    const parsed = await textSourceParser.parse({ fileName: "legacy.txt", mimeType: "text/plain", fileSize: 6, content: Buffer.from("legacy"), config: { chunkSize: 512, parserVersion: "legacy" } });
    if (parsed.content !== "legacy") throw new Error("Legacy parser failed");
    if (Object.keys(require.cache).some(path => path.includes("@firecrawl/anydoc") || path.includes("@firecrawl+anydoc"))) throw new Error("AnyDoc loaded eagerly");
    console.log("legacy-without-anydoc");
  `,
    ],
    { cwd: new URL("..", import.meta.url), encoding: "utf8" },
  );
  assert.match(output, /legacy-without-anydoc/);
});

for (const [name, mime, parser] of [
  ["sample.csv", "text/csv", csvSourceParser],
  ["sample.csv", "application/csv", csvSourceParser],
  ["sample.epub", "application/epub+zip", epubSourceParser],
] as const) {
  test(`AnyDoc ${mime} preserves legacy billing count without making page claims`, async () => {
    const input = await fixture(name, mime);
    const legacy = await parser.parse(input);
    const result = await parseWithAnydoc(input);
    assert.ok((legacy.metadata.pageCount ?? 0) > 0);
    assert.equal(result.metadata.billingPageCount, legacy.metadata.pageCount);
    assert.equal(result.metadata.billingPageCountSource, "legacy-loader");
    assert.equal(result.metadata.pageCount, undefined);
    assert.deepEqual(result.pages, []);
  });
}

test("DOCX and PPTX retain one document billing unit without a physical page count", async () => {
  for (const [name, mime] of [
    [
      "sample.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
    [
      "sample.pptx",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ],
  ]) {
    const result = await parseWithAnydoc(await fixture(name!, mime!));
    assert.equal(result.metadata.billingPageCount, 1);
    assert.equal(result.metadata.billingPageCountSource, "document");
    assert.equal(result.metadata.pageCount, undefined);
  }
});

test("header-only CSV is rejected instead of indexing headers and estimating billing", async () => {
  for (const mimeType of ["text/csv", "application/csv"]) {
    for (const csv of ["name,value", "name,value\n\n"]) {
      const input = {
        ...(await fixture("sample.csv", mimeType)),
        content: Buffer.from(csv),
        fileSize: Buffer.byteLength(csv),
      };
      await assert.rejects(
        () => parseWithAnydoc(input),
        (error: unknown) => {
          assert.ok(error instanceof Error && "code" in error);
          assert.equal(error.code, "ANYDOC_NO_INDEXABLE_RECORDS");
          return true;
        },
      );
    }
  }
});

test("CSV empty fields and blank records retain the existing record-count semantics", async () => {
  for (const csv of ["name,value\n,\n", "name,value\nalpha,1\n\nbeta,2\n"]) {
    const input = {
      ...(await fixture("sample.csv", "text/csv")),
      content: Buffer.from(csv),
      fileSize: Buffer.byteLength(csv),
    };
    const legacy = await csvSourceParser.parse(input);
    const result = await parseWithAnydoc(input);
    // Legacy documents contain column labels even when all field values are empty.
    assert.ok((legacy.metadata.pageCount ?? 0) > 0);
    assert.ok((legacy.metadata.pageCount ?? 0) > 0);
    assert.equal(result.metadata.billingPageCount, legacy.metadata.pageCount);
  }
});

test("EPUB with zero legacy billable chapters fails instead of estimating", async () => {
  const input = await fixture(
    "legacy-zero-chapters.epub",
    "application/epub+zip",
  );
  const legacy = await epubSourceParser.parse(input);
  assert.equal(legacy.metadata.pageCount, 0);
  await assert.rejects(
    () => parseWithAnydoc(input),
    (error: unknown) => {
      assert.ok(error instanceof Error && "code" in error);
      assert.equal(error.code, "ANYDOC_NO_INDEXABLE_RECORDS");
      return true;
    },
  );
});
