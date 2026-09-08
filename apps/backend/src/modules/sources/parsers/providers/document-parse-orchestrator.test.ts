import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { ProviderParseInput, ProviderParseOutcome } from "./types";

const parsers = vi.hoisted(() => ({
  anydoc: vi.fn(),
  classifyPdf: vi.fn(),
  langchain: vi.fn(),
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
vi.mock("./pdf-classifier", () => ({ classifyPdf: parsers.classifyPdf }));
vi.mock("./langchain-pdf-provider", () => ({
  langChainPdfProvider: {
    id: "langchain",
    supports: (mimeType: string) => mimeType === "application/pdf",
    start: parsers.langchain,
  },
}));
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
  vi.stubEnv("DOCUMENT_PARSE_PROVIDER", "langchain");
  vi.stubEnv("DOCUMENT_PARSE_STRATEGY", "explicit");
  vi.stubEnv("DOCUMENT_PARSE_OCR_ENABLED", "false");
  vi.stubEnv("DOCUMENT_PARSE_IMAGE_STRATEGY", "vision");
  parsers.anydoc.mockResolvedValue(completed.document);
  parsers.langchain.mockResolvedValue(completed);
  parsers.pdf2markdown.mockResolvedValue(completed);
  parsers.vision.mockResolvedValue({ kind: "completed", outcome: completed });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

for (const provider of ["langchain", "pdf2markdown"] as const) {
  test(`normalized ${provider} config reaches the actual registry with one implementation`, async () => {
    vi.stubEnv("DOCUMENT_PARSE_PROVIDER", `  ${provider.toUpperCase()}  `);
    const { startDocumentParse } =
      await import("./document-parse-orchestrator");
    const outcome = await startDocumentParse(input());
    assert.equal(
      outcome.diagnostics?.metadata?.documentParseProviderRequested,
      provider,
    );
    assert.equal(
      outcome.diagnostics?.metadata?.documentParseProviderResolved,
      provider,
    );
    assert.equal(parsers[provider].mock.calls.length, 1);
    assert.equal(
      parsers[provider === "langchain" ? "pdf2markdown" : "langchain"].mock
        .calls.length,
      0,
    );
  });
}

for (const strategy of ["explicit", "balanced", "cost"]) {
  for (const mimeType of ["application/pdf", "image/png"]) {
    test(`invalid provider prevents ${strategy} ${mimeType} classification, vision and provider calls`, async () => {
      vi.stubEnv("DOCUMENT_PARSE_PROVIDER", "pdf2markdwon");
      vi.stubEnv("DOCUMENT_PARSE_STRATEGY", strategy);
      await assert.rejects(async () => {
        const { startDocumentParse } =
          await import("./document-parse-orchestrator");
        await startDocumentParse(input(mimeType));
      }, /DOCUMENT_PARSE_PROVIDER must be one of/);
      for (const parser of Object.values(parsers))
        assert.equal(parser.mock.calls.length, 0);
    });
  }
}

for (const laterValue of ["pdf2markdown", "invalid-provider"]) {
  test(`later raw env ${laterValue} cannot replace the parsed deployment provider`, async () => {
    const { startDocumentParse } =
      await import("./document-parse-orchestrator");
    vi.stubEnv("DOCUMENT_PARSE_PROVIDER", laterValue);
    const outcome = await startDocumentParse(input());
    assert.equal(
      outcome.diagnostics?.metadata?.documentParseProviderRequested,
      "langchain",
    );
    assert.equal(parsers.langchain.mock.calls.length, 1);
    assert.equal(parsers.pdf2markdown.mock.calls.length, 0);
  });
}

test("a later raw env change cannot leak an invalid provider into image diagnostics", async () => {
  const { startDocumentParse } = await import("./document-parse-orchestrator");
  vi.stubEnv("DOCUMENT_PARSE_PROVIDER", "invalid-provider");
  const outcome = await startDocumentParse(input("image/png"));
  assert.equal(
    outcome.diagnostics?.metadata?.documentParseProviderRequested,
    "langchain",
  );
  assert.equal(
    outcome.diagnostics?.metadata?.documentParseProviderResolved,
    "vision",
  );
  assert.equal(parsers.vision.mock.calls.length, 1);
  assert.equal(parsers.pdf2markdown.mock.calls.length, 0);
});

for (const provider of ["docling", "llamaparse", "unstructured"]) {
  test(`accepted placeholder ${provider} retains the registry's not implemented error`, async () => {
    vi.stubEnv("DOCUMENT_PARSE_PROVIDER", provider);
    const { startDocumentParse } =
      await import("./document-parse-orchestrator");
    await assert.rejects(
      startDocumentParse(input()),
      new RegExp(`Document parse provider is not implemented: ${provider}`),
    );
    assert.equal(parsers.langchain.mock.calls.length, 0);
    assert.equal(parsers.pdf2markdown.mock.calls.length, 0);
  });
}

test("an explicit provider execution failure propagates without choosing another implementation", async () => {
  const failure = new Error("configured parser failed");
  parsers.langchain.mockRejectedValue(failure);
  const { startDocumentParse } = await import("./document-parse-orchestrator");
  await assert.rejects(
    startDocumentParse(input()),
    (error) => error === failure,
  );
  assert.equal(parsers.langchain.mock.calls.length, 1);
  assert.equal(parsers.pdf2markdown.mock.calls.length, 0);
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
    assert.equal(parsers.classifyPdf.mock.calls.length, 0);
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
  assert.equal(parsers.langchain.mock.calls.length, 0);
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

for (const phase of ["classification", "local parse"]) {
  test(`balanced PDF ${phase} failure is not treated as a remote routing decision`, async () => {
    vi.stubEnv("DOCUMENT_PARSE_PROVIDER", "pdf2markdown");
    vi.stubEnv("DOCUMENT_PARSE_STRATEGY", "balanced");
    const failure = new Error(`${phase} failed`);
    parsers.classifyPdf.mockResolvedValue({
      kind: "pure_text",
      confidence: 1,
      bitmapCoverage: [0],
      pageCount: 1,
    });
    if (phase === "classification")
      parsers.classifyPdf.mockRejectedValue(failure);
    else parsers.langchain.mockRejectedValue(failure);
    const { startDocumentParse } =
      await import("./document-parse-orchestrator");
    await assert.rejects(
      startDocumentParse(input()),
      (error) => error === failure,
    );
    assert.equal(parsers.pdf2markdown.mock.calls.length, 0);
  });
}

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

for (const provider of ["anydoc", "pdf2markdown"]) {
  test(`${provider} registry declarations match dispatch and reject unverified Office formats`, async () => {
    vi.stubEnv("DOCUMENT_PARSE_PROVIDER", provider);
    const {
      getSourceParser,
      listSupportedSourceMimeTypes,
      documentProviderParser,
    } = await import("../index");
    const supported = listSupportedSourceMimeTypes();
    const docxMime =
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    const parser = getSourceParser(docxMime);
    assert.ok(parser);
    assert.equal(parser.supportedMimeTypes.includes(docxMime), true);
    assert.equal(parser === documentProviderParser, provider === "anydoc");
    assert.equal(
      supported.includes("application/msword"),
      provider !== "anydoc",
    );
    assert.equal(
      getSourceParser("application/msword") === null,
      provider === "anydoc",
    );
    assert.equal(
      getSourceParser(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ),
      null,
    );
    for (const mimeType of supported)
      assert.equal(
        getSourceParser(mimeType)?.supportedMimeTypes.includes(mimeType),
        true,
      );
    assert.equal(getSourceParser("text/plain")?.id, "text");
    assert.equal(getSourceParser("application/json")?.id, "json");
    assert.equal(getSourceParser("text/srt")?.id, "srt");
    vi.stubEnv(
      "DOCUMENT_PARSE_PROVIDER",
      provider === "anydoc" ? "pdf2markdown" : "anydoc",
    );
    assert.equal(getSourceParser(docxMime), parser);
    assert.equal(
      getSourceParser("application/msword") === null,
      provider === "anydoc",
    );
  });
}
