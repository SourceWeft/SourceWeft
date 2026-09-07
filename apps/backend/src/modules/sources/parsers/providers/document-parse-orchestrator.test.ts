import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { ProviderParseInput, ProviderParseOutcome } from "./types";

const parsers = vi.hoisted(() => ({
  classifyPdf: vi.fn(),
  langchain: vi.fn(),
  pdf2markdown: vi.fn(),
  vision: vi.fn(),
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
