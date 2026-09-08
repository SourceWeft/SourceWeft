import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { ProviderParseInput, ProviderParseOutcome } from "./types";

const parsers = vi.hoisted(() => ({
  anydoc: vi.fn(),
  pdf2markdown: vi.fn(),
  vision: vi.fn(),
}));

vi.mock("@sourceweft/builtin-document-parsers", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@sourceweft/builtin-document-parsers")
  >()),
  parseWithAnydoc: parsers.anydoc,
}));
vi.mock("dotenv/config", () => ({}));
vi.mock("./pdf2markdown-provider", () => ({
  pdf2MarkdownProvider: {
    id: "pdf2markdown",
    supports: () => true,
    start: parsers.pdf2markdown,
  },
}));
vi.mock("./image-vision-provider", () => ({
  tryParseImageWithVision: parsers.vision,
}));

function input(mimeType = "application/pdf"): ProviderParseInput {
  return {
    content: Buffer.from("parser boundary fixture"),
    fileName: mimeType === "application/pdf" ? "document.pdf" : "image.png",
    mimeType,
    fileSize: 23,
    config: { chunkSize: 512, parserVersion: "test" },
    sourceId: "source-1",
    teamId: "team-1",
    workspaceId: "workspace-1",
    userId: "user-1",
  };
}

const completed: ProviderParseOutcome = {
  kind: "completed",
  document: {
    title: "Document",
    content: "Parsed content",
    metadata: { mimeType: "application/pdf", charCount: 14 },
    pages: [],
    chunks: [],
  },
};

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubEnv("DOCUMENT_PARSE_PROVIDER", "anydoc");
  vi.stubEnv("DOCUMENT_PARSE_STRATEGY", "explicit");
  vi.stubEnv("DOCUMENT_PARSE_OCR_ENABLED", "false");
  vi.stubEnv("DOCUMENT_PARSE_IMAGE_STRATEGY", "vision");
  parsers.anydoc.mockResolvedValue(completed.document);
  parsers.pdf2markdown.mockResolvedValue(completed);
  parsers.vision.mockResolvedValue({ kind: "completed", outcome: completed });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

for (const mimeType of [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/csv",
]) {
  test(`AnyDoc routes ${mimeType} locally with no classification or remote call`, async () => {
    vi.stubEnv("DOCUMENT_PARSE_PROVIDER", "anydoc");
    const { startDocumentParse, isDocumentProviderMimeType } =
      await import("./document-parse-orchestrator");
    assert.equal(isDocumentProviderMimeType(mimeType), true);
    const outcome = await startDocumentParse(input(mimeType));
    assert.equal(outcome.kind, "completed");
    assert.equal(
      outcome.diagnostics?.metadata?.documentParseEntryEngine,
      "anydoc",
    );
    assert.equal(parsers.anydoc.mock.calls.length, 1);
    assert.equal(parsers.pdf2markdown.mock.calls.length, 0);
  });
}

test("AnyDoc needsOcr invokes the declared async backend and preserves task context", async () => {
  vi.stubEnv("DOCUMENT_PARSE_PROVIDER", "anydoc");
  vi.stubEnv("DOCUMENT_PARSE_OCR_ENABLED", "true");
  parsers.anydoc.mockRejectedValue(
    Object.assign(new Error("OCR required"), { code: "needsOcr" }),
  );
  const parseInput = input();
  const token = {
    backendId: "pdf2markdown",
    taskId: "ocr-task",
    sourceId: parseInput.sourceId,
  };
  parsers.pdf2markdown.mockResolvedValue({
    kind: "pending",
    token,
    diagnostics: { metadata: { actualTask: "ocr-task" } },
  });
  const { startDocumentParse } = await import("./document-parse-orchestrator");
  const outcome = await startDocumentParse(parseInput);
  assert.equal(outcome.kind, "pending");
  if (outcome.kind === "pending") assert.equal(outcome.token, token);
  assert.equal(parsers.pdf2markdown.mock.calls[0]?.[0], parseInput);
  assert.equal(
    outcome.diagnostics?.metadata?.documentParseProviderResolved,
    "pdf2markdown",
  );
  assert.equal(
    outcome.diagnostics?.metadata?.documentParseEntryEngine,
    "anydoc",
  );
  assert.equal(outcome.diagnostics?.metadata?.actualTask, "ocr-task");
});

test("needsOcr cannot enable OCR through credentials or error text", async () => {
  vi.stubEnv("DOCUMENT_PARSE_PROVIDER", "anydoc");
  vi.stubEnv("PDF2MARKDOWN_API_KEY", "configured-credential");
  parsers.anydoc.mockRejectedValue(
    Object.assign(new Error("OCR required"), { code: "needsOcr" }),
  );
  const { startDocumentParse } = await import("./document-parse-orchestrator");
  await assert.rejects(
    startDocumentParse(input()),
    /DOCUMENT_PARSE_OCR_ENABLED/,
  );
  assert.equal(parsers.pdf2markdown.mock.calls.length, 0);
});

for (const code of ["encrypted", "invalidPdf", "resourceLimit", undefined]) {
  test(`AnyDoc ${code} errors never select OCR`, async () => {
    vi.stubEnv("DOCUMENT_PARSE_PROVIDER", "anydoc");
    vi.stubEnv("DOCUMENT_PARSE_OCR_ENABLED", "true");
    const failure = Object.assign(
      new Error("needsOcr in unrelated error text"),
      { code },
    );
    parsers.anydoc.mockRejectedValue(failure);
    const { startDocumentParse } =
      await import("./document-parse-orchestrator");
    await assert.rejects(
      startDocumentParse(input()),
      (error) => error === failure,
    );
    assert.equal(parsers.pdf2markdown.mock.calls.length, 0);
  });
}

test("configured OCR failure propagates without another parser", async () => {
  vi.stubEnv("DOCUMENT_PARSE_PROVIDER", "anydoc");
  vi.stubEnv("DOCUMENT_PARSE_OCR_ENABLED", "true");
  parsers.anydoc.mockRejectedValue(
    Object.assign(new Error("OCR required"), { code: "needsOcr" }),
  );
  const failure = new Error("remote OCR unavailable");
  parsers.pdf2markdown.mockRejectedValue(failure);
  const { startDocumentParse } = await import("./document-parse-orchestrator");
  await assert.rejects(
    startDocumentParse(input()),
    (error) => error === failure,
  );
  assert.equal(parsers.pdf2markdown.mock.calls.length, 1);
});

test("vision failure does not switch an image to OCR", async () => {
  vi.stubEnv("DOCUMENT_PARSE_OCR_ENABLED", "true");
  parsers.vision.mockResolvedValue({
    kind: "fallback",
    reason: "vision unavailable",
  });
  const { startDocumentParse } = await import("./document-parse-orchestrator");
  await assert.rejects(
    startDocumentParse(input("image/png")),
    /vision unavailable/,
  );
  assert.equal(parsers.pdf2markdown.mock.calls.length, 0);
});

test("explicit image OCR bypasses vision and never claims the AnyDoc engine", async () => {
  vi.stubEnv("DOCUMENT_PARSE_PROVIDER", "anydoc");
  vi.stubEnv("DOCUMENT_PARSE_IMAGE_STRATEGY", "ocr");
  vi.stubEnv("DOCUMENT_PARSE_OCR_ENABLED", "true");
  const { startDocumentParse } = await import("./document-parse-orchestrator");
  const outcome = await startDocumentParse(input("image/png"));
  assert.equal(
    outcome.diagnostics?.metadata?.documentParseEntryEngine,
    undefined,
  );
  assert.equal(parsers.vision.mock.calls.length, 0);
  assert.equal(parsers.pdf2markdown.mock.calls.length, 1);
});

test("AnyDoc rejects unknown MIME types before parsing or OCR", async () => {
  vi.stubEnv("DOCUMENT_PARSE_PROVIDER", "anydoc");
  vi.stubEnv("DOCUMENT_PARSE_OCR_ENABLED", "true");
  const { startDocumentParse, isDocumentProviderMimeType } =
    await import("./document-parse-orchestrator");
  assert.equal(isDocumentProviderMimeType("application/x-unknown"), false);
  await assert.rejects(
    startDocumentParse(input("application/x-unknown")),
    /does not support MIME type/,
  );
  assert.equal(parsers.anydoc.mock.calls.length, 0);
  assert.equal(parsers.pdf2markdown.mock.calls.length, 0);
});

test("synchronous registry sends supported Office files through AnyDoc", async () => {
  vi.stubEnv("DOCUMENT_PARSE_PROVIDER", "anydoc");
  const { getSourceParser } = await import("../index");
  const mimeType =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const parser = getSourceParser(mimeType);
  assert.ok(parser);
  const document = await parser.parse(input(mimeType));
  assert.equal(parsers.anydoc.mock.calls.length, 1);
  assert.equal(document.metadata.documentParseEntryEngine, "anydoc");
  assert.equal(document.metadata.documentParseBackend, "anydoc");
  assert.equal(getSourceParser("application/x-unknown"), null);
});

test("every AnyDoc catalog MIME has one declared provider route", async () => {
  const { anydocMimeTypes } =
    await import("@sourceweft/builtin-document-parsers/formats");
  const {
    getSourceParser,
    listSupportedSourceMimeTypes,
    documentProviderParser,
  } = await import("../index");
  const { startDocumentParse, isDocumentProviderMimeType } =
    await import("./document-parse-orchestrator");
  const supported = listSupportedSourceMimeTypes();
  for (const mimeType of anydocMimeTypes) {
    assert.equal(isDocumentProviderMimeType(mimeType), true);
    assert.equal(getSourceParser(mimeType), documentProviderParser);
    assert.equal(
      documentProviderParser.supportedMimeTypes.includes(mimeType),
      true,
    );
    assert.equal(supported.includes(mimeType), true);
    const outcome = await startDocumentParse(input(mimeType));
    assert.equal(
      outcome.diagnostics?.metadata?.documentParseProviderResolved,
      "anydoc",
    );
  }
  assert.equal(parsers.anydoc.mock.calls.length, anydocMimeTypes.length);
  assert.equal(parsers.pdf2markdown.mock.calls.length, 0);
  assert.equal(getSourceParser("application/json")?.id, "json");
  assert.equal(getSourceParser("text/srt")?.id, "srt");
});

test("direct parser canonicalizes every catalog MIME alias and preserves provenance", async () => {
  const { anydocFormatCatalog } =
    await import("@sourceweft/builtin-document-parsers/formats");
  const { documentProviderParser } =
    await import("../document-provider-parser");
  for (const entry of anydocFormatCatalog) {
    for (const alias of entry.mimeAliases) {
      const document = await documentProviderParser.parse(input(alias));
      assert.equal(parsers.anydoc.mock.lastCall?.[0].mimeType, entry.mimeType);
      assert.equal(document.metadata.documentParseInputMimeType, alias);
      assert.equal(
        document.metadata.documentParseCanonicalMimeType,
        entry.mimeType,
      );
    }
  }
});

test("scanned PDF aliases use canonical MIME for the declared OCR branch", async () => {
  vi.stubEnv("DOCUMENT_PARSE_OCR_ENABLED", "true");
  parsers.anydoc.mockRejectedValue(
    Object.assign(new Error("OCR required"), { code: "needsOcr" }),
  );
  const { startDocumentParse } = await import("./document-parse-orchestrator");
  const { anydocFormatCatalog } =
    await import("@sourceweft/builtin-document-parsers/formats");
  const pdf = anydocFormatCatalog.find((entry) => entry.format === "pdf")!;
  for (const alias of pdf.mimeAliases) {
    const outcome = await startDocumentParse(input(alias));
    assert.equal(
      parsers.pdf2markdown.mock.lastCall?.[0].mimeType,
      "application/pdf",
    );
    assert.equal(
      outcome.diagnostics?.metadata?.documentParseInputMimeType,
      alias,
    );
    assert.equal(
      outcome.diagnostics?.metadata?.documentParseProviderResolved,
      "pdf2markdown",
    );
  }
});
