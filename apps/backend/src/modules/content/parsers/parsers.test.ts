process.env.S3_BUCKET = process.env.S3_BUCKET || "test-bucket";
process.env.PDF2MARKDOWN_API_KEY =
  process.env.PDF2MARKDOWN_API_KEY || "test-pdf2markdown-key";
process.env.MODEL_GATEWAY_ENCRYPTION_SECRET =
  process.env.MODEL_GATEWAY_ENCRYPTION_SECRET || "test-encryption-secret";
process.env.DOCUMENT_PARSE_STRATEGY = "explicit";
process.env.DOCUMENT_PARSE_PROVIDER = "langchain";

import test from "node:test";
import assert from "node:assert/strict";
import { estimateAsrPageCount, formatAsrTranscriptMarkdown } from "./audio";
import { WebFetchSourceParser } from "./web-fetch";
import type { WebProvider } from "../web";
import { csvSourceParser } from "./csv";
import { docxSourceParser } from "./docx";
import { epubSourceParser } from "./epub";
import { jsonSourceParser } from "./json";
import { pdfSourceParser } from "./pdf";
import { pptxSourceParser } from "./pptx";
import { srtSourceParser } from "./srt";
import { textSourceParser } from "./text";
import { getSourceParser, listSupportedSourceMimeTypes } from "./index";
import { extractPdf2MarkdownResult } from "./providers/pdf2markdown-result";
import { startDocumentParse, testExports as documentParseTestExports } from "./providers/document-parse-orchestrator";
import { testExports as imageVisionTestExports } from "./providers/image-vision-provider";
import { classifySourceFile } from "../source-file-classifier";
import { buildSourceStorageKey } from "../storage";

const docxBase64 = "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";

test("text parser extracts content, metadata, and chunks", async () => {
  const result = await textSourceParser.parse({
    fileName: "notes.md",
    mimeType: "text/markdown",
    fileSize: 14,
    content: Buffer.from("# Hello\n\nWorld"),
    config: {
      chunkSize: 512,
      parserVersion: "v1",
    },
  });
  assert.equal(result.title, "notes.md");
  assert.equal(result.content, "# Hello\n\nWorld");
  assert.equal(result.metadata.mimeType, "text/markdown");
  assert.equal(result.metadata.charCount, 14);
  assert.equal(result.pages.length, 1);
  assert.equal(result.chunks.length > 0, true);
});
test("text parser rejects binary-looking text files", async () => {
  await assert.rejects(
    () =>
      textSourceParser.parse({
        fileName: "notes.txt",
        mimeType: "text/plain",
        fileSize: 4,
        content: Buffer.from([0, 1, 2, 3]),
        config: {
          chunkSize: 512,
          parserVersion: "v1",
        },
      }),
    /appears to be binary/,
  );
});
test("audio page estimator uses ten minute billing pages", () => {
  assert.equal(estimateAsrPageCount({ duration: 60 }), 1);
  assert.equal(estimateAsrPageCount({ duration: 10 * 60 }), 1);
  assert.equal(estimateAsrPageCount({ duration: 10 * 60 + 1 }), 2);
  assert.equal(estimateAsrPageCount({ duration: 21 * 60 }), 3);
  assert.equal(
    estimateAsrPageCount({ inputLengthMs: 20 * 60 * 1000, duration: 60 }),
    2,
  );
  assert.equal(estimateAsrPageCount({}), 1);
});
test("csv parser converts rows into content and chunks", async () => {
  const result = await csvSourceParser.parse({
    fileName: "table.csv",
    mimeType: "text/csv",
    fileSize: 27,
    content: Buffer.from("name,value\nalpha,1\nbeta,2\n"),
    config: {
      chunkSize: 512,
      parserVersion: "v1",
    },
  });
  assert.equal(result.metadata.mimeType, "text/csv");
  assert.equal(result.pages.length, 2);
  assert.equal(result.content.includes("alpha"), true);
  assert.equal(result.chunks.length > 0, true);
});
test("json parser extracts nested string content and chunks", async () => {
  const result = await jsonSourceParser.parse({
    fileName: "data.json",
    mimeType: "application/json",
    fileSize: 43,
    content: Buffer.from(JSON.stringify({ title: "Hello", body: { text: "World" } })),
    config: {
      chunkSize: 512,
      parserVersion: "v1",
    },
  });
  assert.equal(result.metadata.mimeType, "application/json");
  assert.equal(result.content.includes("Hello"), true);
  assert.equal(result.content.includes("World"), true);
  assert.equal(result.chunks.length > 0, true);
});
test("pdf parser extracts content, metadata, and page count", async () => {
  const content = Buffer.from(
    "JVBERi0xLjQKJcOiw6MKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAzMDAgMTQ0XSAvQ29udGVudHMgNCAwIFIgL0ZvbnQgPDwgL0YxIDUgMCBSID4+ID4+CmVuZG9iago0IDAgb2JqCjw8IC9MZW5ndGggNDQgPj4Kc3RyZWFtCkJUCi9GMSAyNCBUZgoxMDAgMTAwIFRkCihIZWxsbyBQREYpIFRqCkVUCmVuZHN0cmVhbQplbmRvYmoKNSAwIG9iago8PCAvVHlwZSAvRm9udCAvU3VidHlwZSAvVHlwZTEgL0Jhc2VGb250IC9IZWx2ZXRpY2EgPj4KZW5kb2JqCnhyZWYKMCA2CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAxNSAwMDAwMCBuIAowMDAwMDAwMDY0IDAwMDAwIG4gCjAwMDAwMDAxMjEgMDAwMDAgbiAKMDAwMDAwMDI0NyAwMDAwMCBuIAowMDAwMDAwMzQxIDAwMDAwIG4gCnRyYWlsZXIKPDwgL1NpemUgNiAvUm9vdCAxIDAgUiA+PgpzdGFydHhyZWYKMzk5CiUlRU9G",
    "base64",
  );
  const result = await pdfSourceParser.parse({
    fileName: "hello.pdf",
    mimeType: "application/pdf",
    fileSize: content.length,
    content,
    config: {
      chunkSize: 512,
      parserVersion: "v1",
    },
  });
  assert.equal(result.title, "hello.pdf");
  assert.equal(result.metadata.mimeType, "application/pdf");
  assert.equal(result.metadata.pageCount, 1);
  assert.equal(result.metadata.charCount, 0);
  assert.equal(result.content, "");
  assert.equal(result.pages.length, 0);
  assert.equal(result.chunks.length, 0);
});
test("image document parse uses vision markdown when vision succeeds", async () => {
  const restoreVisionParser = documentParseTestExports.setImageVisionParserForTest(
    async (input) => ({
      kind: "completed",
      outcome: {
        kind: "completed",
        document: {
          title: input.fileName,
          content: "A chart showing revenue growth.\n\nVisible text: Q1 Revenue",
          metadata: {
            fileName: input.fileName,
            fileSize: input.fileSize,
            mimeType: input.mimeType,
            pageCount: 1,
            documentParseBackend: "vision",
            documentParseProvider: "vision",
            documentParseProviderResolved: "vision",
            documentParseMode: "image_vision",
            visionModelAlias: "vision-default",
            visionProfileAlias: "vision-default",
          },
          pages: [
            {
              pageNumber: 1,
              content: "A chart showing revenue growth.\n\nVisible text: Q1 Revenue",
            },
          ],
          chunks: [
            {
              text: "A chart showing revenue growth.\n\nVisible text: Q1 Revenue",
              startIndex: 0,
              endIndex: 58,
              tokenCount: 15,
            },
          ],
        },
      },
    }),
  );
  try {
    const result = await startDocumentParse({
      fileName: "chart.png",
      mimeType: "image/png",
      fileSize: 4,
      content: Buffer.from([1, 2, 3, 4]),
      config: {
        chunkSize: 512,
        parserVersion: "v1",
      },
      sourceId: "source-1",
      sourceRevisionId: "revision-1",
      teamId: "team-1",
      workspaceId: "workspace-1",
      userId: "user-1",
    });

    assert.equal(result.kind, "completed");
    assert.equal(result.document.content.includes("revenue growth"), true);
    assert.equal(result.document.metadata.documentParseMode, "image_vision");
    assert.equal(result.document.metadata.documentParseBackend, "vision");
    assert.equal(result.document.metadata.pageCount, 1);
    assert.equal(result.document.pages.length, 1);
    assert.equal(result.document.chunks.length, 1);
  } finally {
    restoreVisionParser();
  }
});
test("image vision parser strips a wrapping markdown code fence", () => {
  const content = imageVisionTestExports.stripWrappingMarkdownFence(`\`\`\`markdown
# Image Description

The image features a stylized lightning bolt silhouette.

## Text
There is no visible text in the image.
\`\`\``);

  assert.equal(content.startsWith("```markdown"), false);
  assert.equal(content.endsWith("```"), false);
  assert.equal(content.includes("# Image Description"), true);
});
test("image document parse falls back to OCR with one-page metadata when vision fails", async (t) => {
  const restoreVisionParser = documentParseTestExports.setImageVisionParserForTest(
    async () => ({
      kind: "fallback",
      reason: "Default vision model gateway profile is not configured",
    }),
  );
  const fetchMock = t.mock.method(globalThis, "fetch", async () =>
    new Response(
      JSON.stringify({
        code: "ok",
        data: {
          task_id: "task-1",
          status: "queued",
          page_count: 9,
        },
      }),
      { status: 200 },
    ),
  );
  try {
    const result = await startDocumentParse({
      fileName: "receipt.png",
      mimeType: "image/png",
      fileSize: 4,
      content: Buffer.from([1, 2, 3, 4]),
      config: {
        chunkSize: 512,
        parserVersion: "v1",
      },
      sourceId: "source-1",
      sourceRevisionId: "revision-1",
      teamId: "team-1",
      workspaceId: "workspace-1",
      userId: "user-1",
    });

    assert.equal(result.kind, "pending");
    assert.equal(result.diagnostics?.metadata?.documentParseMode, "image_ocr");
    assert.equal(result.diagnostics?.metadata?.visionFallbackReason, "Default vision model gateway profile is not configured");
    assert.equal(result.diagnostics?.metadata?.pageCount, 1);
    assert.equal(result.diagnostics?.metadata?.documentParseProviderResolved, "pdf2markdown");
    assert.equal(fetchMock.mock.callCount(), 1);
  } finally {
    restoreVisionParser();
  }
});
test("docx parser extracts content, metadata, and chunks", async () => {
  const content = Buffer.from(docxBase64, "base64");
  const result = await docxSourceParser.parse({
    fileName: "hello.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    fileSize: content.length,
    content,
    config: {
      chunkSize: 512,
      parserVersion: "v1",
    },
  });
  assert.equal(result.title, "hello.docx");
  assert.equal(
    result.metadata.mimeType,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  assert.equal(result.content.includes("Hello DOCX"), true);
  assert.equal(result.content.includes("Second paragraph."), true);
  assert.equal(result.pages.length, 1);
  assert.equal(result.chunks.length > 0, true);
});
test("srt parser extracts subtitle content and chunks", async () => {
  const content = [
    "1",
    "00:00:01,000 --> 00:00:03,500",
    "Hello world",
    "",
    "2",
    "00:00:04,000 --> 00:00:06,000",
    "This is a subtitle",
    "",
  ].join("\n");
  const result = await srtSourceParser.parse({
    fileName: "subs.srt",
    mimeType: "text/srt",
    fileSize: Buffer.byteLength(content),
    content: Buffer.from(content),
    config: {
      chunkSize: 512,
      parserVersion: "v1",
    },
  });
  assert.equal(result.title, "subs.srt");
  assert.equal(result.metadata.mimeType, "text/srt");
  assert.equal(result.content.includes("Hello world"), true);
  assert.equal(result.content.includes("This is a subtitle"), true);
  assert.equal(result.pages.length > 0, true);
  assert.equal(result.chunks.length > 0, true);
});
test("individual parsers advertise expected mime types", () => {
  assert.equal(textSourceParser.supportedMimeTypes.includes("text/plain"), true);
  assert.equal(
    textSourceParser.supportedMimeTypes.includes("application/typescript"),
    true,
  );
  assert.equal(csvSourceParser.supportedMimeTypes.includes("text/csv"), true);
  assert.equal(jsonSourceParser.supportedMimeTypes.includes("application/json"), true);
  assert.equal(docxSourceParser.supportedMimeTypes.includes("application/msword"), true);
  assert.equal(epubSourceParser.supportedMimeTypes.includes("application/epub+zip"), true);
  assert.equal(
    pptxSourceParser.supportedMimeTypes.includes(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ),
    true,
  );
  assert.equal(srtSourceParser.supportedMimeTypes.includes("text/srt"), true);
});
test("parser registry resolves known mime types", () => {
  assert.equal(getSourceParser("text/markdown")?.id, "text");
  assert.equal(getSourceParser("application/typescript")?.id, "text");
  assert.equal(getSourceParser("application/pdf")?.id, "pdf");
  assert.equal(getSourceParser("image/avif")?.id, "pdf");
  assert.equal(getSourceParser("audio/mpeg")?.id, "audio");
  assert.equal(getSourceParser("audio/mp4")?.id, "audio");
  assert.equal(getSourceParser("video/mp4")?.id, "audio");
  assert.equal(getSourceParser("application/json")?.id, "json");
  assert.equal(getSourceParser("application/epub+zip")?.id, "epub");
  assert.equal(
    getSourceParser("application/vnd.openxmlformats-officedocument.presentationml.presentation")?.id,
    "pptx",
  );
  assert.equal(getSourceParser("text/srt")?.id, "srt");
  assert.equal(getSourceParser("application/octet-stream"), null);
  assert.ok(listSupportedSourceMimeTypes().includes("application/pdf"));
  assert.ok(listSupportedSourceMimeTypes().includes("image/avif"));
  assert.ok(listSupportedSourceMimeTypes().includes("audio/mpeg"));
});
test("source file classifier normalizes broad text/code files", () => {
  assert.deepEqual(classifySourceFile({
    fileName: "component.tsx",
    mimeType: "application/octet-stream",
  }), {
    supported: true,
    kind: "text",
    extension: "tsx",
    mimeType: "application/typescript",
    originalMimeType: null,
    label: "Text",
  });
  assert.deepEqual(classifySourceFile({
    fileName: "Dockerfile",
    mimeType: "text/plain",
  }), {
    supported: true,
    kind: "text",
    extension: "dockerfile",
    mimeType: "text/plain",
    originalMimeType: "text/plain",
    label: "Text",
  });
});
test("source file classifier normalizes image and audio files", () => {
  assert.deepEqual(classifySourceFile({
    fileName: "scan.tif",
    mimeType: "application/octet-stream",
  }), {
    supported: true,
    kind: "image",
    extension: "tif",
    mimeType: "image/tiff",
    originalMimeType: null,
    label: "Image",
  });
  assert.deepEqual(classifySourceFile({
    fileName: "meeting.mp3",
    mimeType: "audio/mpeg",
  }), {
    supported: true,
    kind: "audio",
    extension: "mp3",
    mimeType: "audio/mpeg",
    originalMimeType: "audio/mpeg",
    label: "Audio",
  });
  assert.deepEqual(classifySourceFile({
    fileName: "screen.mp4",
    mimeType: "video/mp4",
  }), {
    supported: true,
    kind: "audio",
    extension: "mp4",
    mimeType: "video/mp4",
    originalMimeType: "video/mp4",
    label: "Audio",
  });
});
test("source file classifier rejects unsupported and conflicting files", () => {
  assert.deepEqual(classifySourceFile({
    fileName: "archive.zip",
    mimeType: "application/zip",
  }), {
    supported: false,
    extension: "zip",
    mimeType: "application/zip",
    reason: "Unsupported file extension '.zip'",
  });
  assert.deepEqual(classifySourceFile({
    fileName: "voice.mp3",
    mimeType: "application/pdf",
  }), {
    supported: false,
    extension: "mp3",
    mimeType: "application/pdf",
    reason: "MIME type 'application/pdf' does not match file extension '.mp3'",
  });
});
test("audio transcript formatter emits segment timestamps", () => {
  const content = formatAsrTranscriptMarkdown({
    fileName: "meeting.mp3",
    result: {
      text: "Hello world",
      segments: [
        { id: 0, start: 0, end: 1, text: "Hello" },
        { id: 1, start: 64, end: 65, text: "World" },
      ],
    },
  });

  assert.equal(
    content,
    "# Transcript: meeting.mp3\n\n[00:00 - 00:01] Hello\n\n[01:04 - 01:05] World",
  );
});

test("web fetch parser extracts markdown without forcing fresh by default", async () => {
  const observedFreshValues: Array<boolean | undefined> = [];
  const provider: WebProvider = {
    name: "test-web",
    async search() {
      throw new Error("search should not be called");
    },
    async fetch(input) {
      observedFreshValues.push(input.fresh);
      return {
        provider: "test-web",
        count: 1,
        results: [{
          url: input.items[0]?.url ?? "https://example.com/article",
          title: "Fetched Title",
          description: "Fetched description",
          markdown: "Fetched markdown content.",
          wordCount: 3,
          truncated: false,
        }],
      };
    },
  };
  const parser = new WebFetchSourceParser(() => provider);

  const result = await parser.parse({
    fileName: "Requested Title",
    mimeType: "text/x-sourceweft-web-url",
    fileSize: 0,
    content: Buffer.from("https://example.com/article"),
    config: { chunkSize: 1000, parserVersion: "v1" },
    sourceExternalUri: "https://example.com/article",
  });

  assert.deepEqual(observedFreshValues, [undefined]);
  assert.equal(result.title, "Fetched Title");
  assert.match(result.content, /Source: https:\/\/example.com\/article/);
  assert.match(result.content, /Fetched markdown content/);
  assert.equal(result.metadata.provider, "test-web");
  assert.equal(result.metadata.parserId, "web-fetch");
});

test("web fetch parser passes fresh only for force refresh", async () => {
  const observedFreshValues: Array<boolean | undefined> = [];
  const provider: WebProvider = {
    name: "test-web",
    async search() {
      throw new Error("search should not be called");
    },
    async fetch(input) {
      observedFreshValues.push(input.fresh);
      return {
        provider: "test-web",
        count: 1,
        results: [{
          url: input.items[0]?.url ?? "https://example.com/article",
          title: "Fetched Title",
          markdown: "Fetched markdown content.",
          wordCount: 3,
          truncated: false,
        }],
      };
    },
  };
  const parser = new WebFetchSourceParser(() => provider);

  await parser.parse({
    fileName: "Requested Title",
    mimeType: "text/x-sourceweft-web-url",
    fileSize: 0,
    content: Buffer.from("https://example.com/article"),
    config: { chunkSize: 1000, parserVersion: "v1" },
    sourceExternalUri: "https://example.com/article",
    forceRefresh: true,
  });

  assert.deepEqual(observedFreshValues, [true]);
});
test("pdf2markdown result extractor handles documented page fields", () => {
  const result = extractPdf2MarkdownResult({
    code: "success",
    data: {
      result: {
        markdown: "# Invoice #2026-01\n\nTotal: $1234.56",
        pages: [
          {
            page_idx: 0,
            page_width: 2480,
            page_height: 3508,
            md: "# Invoice #2026-01\n\nTotal: $1234.56",
            score: 54,
          },
        ],
      },
      uid: "req_9ab2f08c",
    },
  });

  assert.equal(result.content.includes("Invoice #2026-01"), true);
  assert.equal(result.pages.length, 1);
  assert.equal(result.pages[0]?.pageNumber, 1);
  assert.equal(result.pages[0]?.content.includes("Total: $1234.56"), true);
  assert.equal(result.pageCount, 1);
});
test("pdf2markdown result extractor unwraps Meanless html comments", () => {
  const result = extractPdf2MarkdownResult({
    data: {
      result: {
        markdown: "<!-- Meanless: Powerful Features for Modern Web Crawling -->\n\nMain content",
      },
    },
  });

  assert.equal(result.content.includes("Powerful Features for Modern Web Crawling"), true);
  assert.equal(result.content.includes("Main content"), true);
  assert.equal(result.content.includes("Meanless:"), false);
  assert.equal(result.content.includes("<!--"), false);
  assert.equal(result.content.includes("-->"), false);
});
test("pdf2markdown result extractor converts Meanless line breaks", () => {
  const result = extractPdf2MarkdownResult({
    data: {
      result: {
        pages: [
          {
            page_idx: 0,
            md: "<!-- Meanless: spaceship<br>SPACESHIP.COM<br />WG-202604011016536 -->",
          },
        ],
      },
    },
  });

  assert.equal(result.content.includes("spaceship"), true);
  assert.equal(result.content.includes("SPACESHIP.COM"), true);
  assert.equal(result.content.includes("WG-202604011016536"), true);
  assert.equal(result.content.includes("Meanless:"), false);
  assert.equal(result.content.includes("<br"), false);
  assert.equal(result.pages[0]?.content.includes("SPACESHIP.COM"), true);
});
test("pdf2markdown result extractor preserves non-Meanless html comments", () => {
  const result = extractPdf2MarkdownResult({
    data: {
      result: {
        markdown: "<!-- keep this internal note -->\n\nVisible text",
      },
    },
  });

  assert.equal(result.content.includes("<!-- keep this internal note -->"), true);
  assert.equal(result.content.includes("Visible text"), true);
});
test("source storage key is namespaced by workspace and source", () => {
  const key = buildSourceStorageKey({
    workspaceId: "ws_123",
    sourceId: "src_456",
    fileName: "My File.pdf",
  });
  assert.match(key, /^workspaces\/ws_123\/sources\/src_456\/.+-My-File.pdf$/);
});
