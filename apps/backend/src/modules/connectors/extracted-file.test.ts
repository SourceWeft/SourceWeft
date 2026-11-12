import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { ParserContentError } from "@sourceweft/builtin-document-parsers";
import type { SourceFileClassification } from "../sources/source-file-classifier";
import type { ParsedDocument } from "../sources/parsers/types";
import type { ProviderParseOutcome } from "../sources/parsers/providers/types";
import { ConnectorItemSkipError } from "./types";
import type { ConnectorExtractedFileDescriptor } from "./types";
import {
  CONNECTOR_FILE_MAX_BYTES,
  resolveExtractedFile,
} from "./extracted-file";
import {
  DocumentNeedsOcrError,
  startDocumentParse,
} from "../sources/parsers/providers/document-parse-orchestrator";

function classification(
  overrides: Partial<SourceFileClassification> = {},
): SourceFileClassification {
  return {
    supported: true,
    kind: "text",
    extension: "txt",
    mimeType: "text/plain",
    originalMimeType: "text/plain",
    label: "Text",
    ...overrides,
  };
}

function unsupportedClassification() {
  return {
    supported: false as const,
    extension: "zip",
    mimeType: "application/zip",
    reason: "Unsupported file extension '.zip'",
  };
}

function parsedDocument(
  overrides: Partial<ParsedDocument> = {},
): ParsedDocument {
  return {
    title: "doc",
    content: "hello",
    metadata: {},
    pages: [],
    chunks: [],
    ...overrides,
  };
}

function completedOutcome(
  document: Partial<ParsedDocument> = {},
): ProviderParseOutcome {
  return { kind: "completed", document: parsedDocument(document) };
}

function file(
  overrides: Partial<ConnectorExtractedFileDescriptor> = {},
): ConnectorExtractedFileDescriptor {
  return {
    fileName: "report.txt",
    mimeType: "text/plain",
    sizeBytes: 100,
    download: vi.fn(async () => Buffer.from("hello")),
    ...overrides,
  };
}

function baseInput(
  overrides: Partial<Parameters<typeof resolveExtractedFile>[0]> = {},
) {
  return {
    file: file(),
    teamId: "team-1",
    workspaceId: "workspace-1",
    userId: "user-1",
    externalUri: null,
    ...overrides,
  };
}

test("skips an unsupported type without downloading", async () => {
  const download = vi.fn();
  const result = await resolveExtractedFile(
    baseInput({
      file: file({ download }),
      deps: { classify: () => unsupportedClassification() },
    }),
  );

  assert.deepEqual(result, { kind: "skipped", reason: "unsupported_type" });
  assert.equal(download.mock.calls.length, 0);
});

test("skips kinds outside the allowlist (image, audio, transcript)", async () => {
  for (const kind of ["image", "audio", "transcript"] as const) {
    const result = await resolveExtractedFile(
      baseInput({
        deps: { classify: () => classification({ kind }) },
      }),
    );
    assert.deepEqual(result, { kind: "skipped", reason: "unsupported_type" });
  }
});

test("skips a file whose declared size is over the cap without downloading", async () => {
  const download = vi.fn();
  const result = await resolveExtractedFile(
    baseInput({
      file: file({
        sizeBytes: CONNECTOR_FILE_MAX_BYTES + 1,
        download,
      }),
      deps: { classify: () => classification() },
    }),
  );

  assert.deepEqual(result, { kind: "skipped", reason: "too_large" });
  assert.equal(download.mock.calls.length, 0);
});

test("skips when the download reports too large", async () => {
  const download = vi.fn(async () => {
    throw new ConnectorItemSkipError("too_large");
  });
  const result = await resolveExtractedFile(
    baseInput({
      file: file({ sizeBytes: 100, download }),
      deps: { classify: () => classification() },
    }),
  );

  assert.deepEqual(result, { kind: "skipped", reason: "too_large" });
});

test("skips when the downloaded bytes exceed the cap", async () => {
  const oversized = Buffer.alloc(CONNECTOR_FILE_MAX_BYTES + 1);
  const download = vi.fn(async () => oversized);
  const result = await resolveExtractedFile(
    baseInput({
      file: file({ sizeBytes: null, download }),
      deps: { classify: () => classification() },
    }),
  );

  assert.deepEqual(result, { kind: "skipped", reason: "too_large" });
});

test("parses a document with OCR denied", async () => {
  const parseDocument = vi.fn(
    async (_input: Parameters<typeof startDocumentParse>[0]) =>
      completedOutcome({
        content: "hello",
        metadata: { pageCount: 3, pageCountSource: "pdfjs" },
      }),
  );
  const result = await resolveExtractedFile(
    baseInput({
      file: file({ mimeType: "application/pdf" }),
      deps: {
        classify: () =>
          classification({
            kind: "document",
            mimeType: "application/pdf",
            extension: "pdf",
            label: "PDF",
          }),
        isDocumentMime: () => true,
        parseDocument,
      },
    }),
  );

  assert.equal(result.kind, "parsed");
  if (result.kind === "parsed") {
    assert.equal(result.contentText, "hello");
    assert.equal(result.parsedMetadata.pageCount, 3);
  }
  assert.equal(parseDocument.mock.calls.length, 1);
  assert.equal(parseDocument.mock.calls[0]?.[0]?.ocr, "deny");
});

test("maps a needs-OCR document to a skip", async () => {
  const parseDocument = vi.fn(async () => {
    throw new DocumentNeedsOcrError("needs ocr");
  });
  const result = await resolveExtractedFile(
    baseInput({
      file: file({ mimeType: "application/pdf" }),
      deps: {
        classify: () =>
          classification({ kind: "document", mimeType: "application/pdf" }),
        isDocumentMime: () => true,
        parseDocument,
      },
    }),
  );

  assert.deepEqual(result, { kind: "skipped", reason: "needs_ocr" });
});

test("skips a zero-byte document-type file as empty before parsing", async () => {
  const parseDocument = vi.fn();
  const result = await resolveExtractedFile(
    baseInput({
      file: file({
        fileName: "empty.pdf",
        mimeType: "application/pdf",
        sizeBytes: null,
        download: async () => Buffer.alloc(0),
      }),
      deps: {
        classify: () =>
          classification({ kind: "document", mimeType: "application/pdf" }),
        isDocumentMime: () => true,
        parseDocument,
      },
    }),
  );

  assert.deepEqual(result, { kind: "skipped", reason: "empty_content" });
  assert.equal(parseDocument.mock.calls.length, 0);
});

test("maps a parser empty-content code to an empty skip", async () => {
  for (const code of ["ANYDOC_EMPTY_FILE", "ANYDOC_NO_CONTENT"] as const) {
    const parseDocument = vi.fn(async () => {
      throw new ParserContentError(422, code, "no document content");
    });
    const result = await resolveExtractedFile(
      baseInput({
        file: file({ mimeType: "application/pdf" }),
        deps: {
          classify: () =>
            classification({ kind: "document", mimeType: "application/pdf" }),
          isDocumentMime: () => true,
          parseDocument,
        },
      }),
    );

    assert.deepEqual(result, { kind: "skipped", reason: "empty_content" });
  }
});

test("skips an empty document-type file through the real parser as empty_content", async () => {
  // No parse stub: the real startDocumentParse drives the anydoc binding. A
  // valid-but-contentless RTF extracts to "" and must skip, not fail the item.
  const result = await resolveExtractedFile(
    baseInput({
      file: file({
        fileName: "empty.rtf",
        mimeType: "application/rtf",
        sizeBytes: null,
        download: async () => Buffer.from("{\\rtf1\\ansi}"),
      }),
    }),
  );

  assert.deepEqual(result, { kind: "skipped", reason: "empty_content" });
});

test("parses a text file with the text parser", async () => {
  const parseDocument = vi.fn();
  const parse = vi.fn(async () =>
    parsedDocument({ content: "plain text content" }),
  );
  const result = await resolveExtractedFile(
    baseInput({
      deps: {
        classify: () => classification(),
        isDocumentMime: () => false,
        parseDocument,
        getTextParser: () => ({
          id: "text",
          name: "Text",
          supportedMimeTypes: ["text/plain"],
          parse,
        }),
      },
    }),
  );

  assert.equal(result.kind, "parsed");
  if (result.kind === "parsed") {
    assert.equal(result.contentText, "plain text content");
  }
  assert.equal(parseDocument.mock.calls.length, 0);
  assert.equal(parse.mock.calls.length, 1);
});

test("indexes an extensionless PDF by its MIME type", async () => {
  const parseDocument = vi.fn(async () =>
    completedOutcome({ content: "extracted pdf text" }),
  );
  const result = await resolveExtractedFile(
    baseInput({
      file: file({ fileName: "Q3 report", mimeType: "application/pdf" }),
      deps: { parseDocument },
    }),
  );

  assert.equal(result.kind, "parsed");
  assert.equal(parseDocument.mock.calls.length, 1);
});

test("skips a file that parses to blank text", async () => {
  const result = await resolveExtractedFile(
    baseInput({
      deps: {
        classify: () => classification(),
        isDocumentMime: () => false,
        getTextParser: () => ({
          id: "text",
          name: "Text",
          supportedMimeTypes: ["text/plain"],
          parse: async () => parsedDocument({ content: "  \n" }),
        }),
      },
    }),
  );

  assert.deepEqual(result, { kind: "skipped", reason: "empty_content" });
});

test("rethrows an unknown parser error, keeping the original as cause", async () => {
  const parseDocument = vi.fn(async () => {
    throw new Error("boom");
  });
  await assert.rejects(
    resolveExtractedFile(
      baseInput({
        file: file({ mimeType: "application/pdf" }),
        deps: {
          classify: () =>
            classification({ kind: "document", mimeType: "application/pdf" }),
          isDocumentMime: () => true,
          parseDocument,
        },
      }),
    ),
    (error: unknown) =>
      error instanceof Error &&
      error.cause instanceof Error &&
      error.cause.message === "boom",
  );
});

test("skips a deterministic parser rejection as unreadable", async () => {
  const parseDocument = vi.fn(async () => {
    // The anydoc binding rejects with a plain Error carrying a code; this is
    // the real shape for malformed/encrypted/resourceLimit rejections.
    const error = new Error("malformed document: invalid structure");
    (error as { code?: string }).code = "malformed";
    throw error;
  });
  const result = await resolveExtractedFile(
    baseInput({
      file: file({ mimeType: "application/pdf" }),
      deps: {
        classify: () =>
          classification({ kind: "document", mimeType: "application/pdf" }),
        isDocumentMime: () => true,
        parseDocument,
      },
    }),
  );

  assert.deepEqual(result, { kind: "skipped", reason: "unreadable" });
});

test("skips a missing-part document rejection as unreadable", async () => {
  const parseDocument = vi.fn(async () => {
    // Anydoc rejects a container that is missing a required part with a plain
    // Error carrying the `missingPart` code — deterministic, so it must skip.
    const error = new Error("missing required part");
    (error as { code?: string }).code = "missingPart";
    throw error;
  });
  const result = await resolveExtractedFile(
    baseInput({
      file: file({ mimeType: "application/pdf" }),
      deps: {
        classify: () =>
          classification({ kind: "document", mimeType: "application/pdf" }),
        isDocumentMime: () => true,
        parseDocument,
      },
    }),
  );

  assert.deepEqual(result, { kind: "skipped", reason: "unreadable" });
});

test("skips a corrupt document through the real parser as unreadable", async () => {
  const result = await resolveExtractedFile(
    baseInput({
      file: file({
        fileName: "corrupt.pdf",
        mimeType: "application/pdf",
        sizeBytes: null,
        download: async () => Buffer.from("%PDF-1.4\nnot a real pdf body at all"),
      }),
    }),
  );

  assert.deepEqual(result, { kind: "skipped", reason: "unreadable" });
});

test("sanitizes a thrown parse error so no file text reaches its message", async () => {
  const marker = "SENSITIVE_FILE_SNIPPET_8f3a";
  const parse = vi.fn(async () => {
    throw new Error(`Unexpected token in JSON at position 3: ${marker}`);
  });
  await assert.rejects(
    resolveExtractedFile(
      baseInput({
        file: file({ fileName: "data.json", mimeType: "application/json" }),
        deps: {
          classify: () =>
            classification({ kind: "json", mimeType: "application/json" }),
          isDocumentMime: () => false,
          getTextParser: () => ({
            id: "json",
            name: "JSON",
            supportedMimeTypes: ["application/json"],
            parse,
          }),
        },
      }),
    ),
    (error: unknown) =>
      error instanceof Error && !error.message.includes(marker),
  );
});

test("skips when the text lookup returns a non-text parser", async () => {
  const parse = vi.fn();
  const result = await resolveExtractedFile(
    baseInput({
      deps: {
        classify: () => classification(),
        isDocumentMime: () => false,
        getTextParser: () => ({
          id: "pdf",
          name: "Document Provider Parser",
          supportedMimeTypes: ["text/plain"],
          parse,
        }),
      },
    }),
  );

  assert.deepEqual(result, { kind: "skipped", reason: "unsupported_type" });
  assert.equal(parse.mock.calls.length, 0);
});

test("skips a type the classifier accepts but no parser handles", async () => {
  const result = await resolveExtractedFile(
    baseInput({
      deps: {
        classify: () => classification({ kind: "table", mimeType: "text/csv" }),
        isDocumentMime: () => false,
        getTextParser: () => null,
      },
    }),
  );

  assert.deepEqual(result, { kind: "skipped", reason: "unsupported_type" });
});
