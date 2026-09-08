import { afterAll, test, vi } from "vitest";

const originalParserEnvironment = vi.hoisted(() => {
  const names = [
    "S3_BUCKET",
    "PDF2MARKDOWN_API_KEY",
    "MODEL_GATEWAY_ENCRYPTION_SECRET",
    "DOCUMENT_PARSE_STRATEGY",
    "DOCUMENT_PARSE_PROVIDER",
  ] as const;
  const original = names.map((name) => [name, process.env[name]] as const);
  process.env.S3_BUCKET ||= "test-bucket";
  process.env.PDF2MARKDOWN_API_KEY ||= "test-pdf2markdown-key";
  process.env.MODEL_GATEWAY_ENCRYPTION_SECRET ||= "test-encryption-secret";
  process.env.DOCUMENT_PARSE_STRATEGY = "explicit";
  process.env.DOCUMENT_PARSE_PROVIDER = "anydoc";
  return original;
});

afterAll(() => {
  for (const [name, value] of originalParserEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});
import assert from "node:assert/strict";
import { estimateAsrPageCount, formatAsrTranscriptMarkdown } from "./audio";
import { WebFetchSourceParser } from "./web-fetch";
import {
  jsonSourceParser,
  srtSourceParser,
} from "@sourceweft/builtin-document-parsers";
import { textSourceParser } from "./text";
import { getSourceParser } from "./index";
import { extractPdf2MarkdownResult } from "@sourceweft/builtin-document-parsers";
import {
  startDocumentParse,
  testExports as documentParseTestExports,
} from "./providers/document-parse-orchestrator";
import { testExports as imageVisionTestExports } from "./providers/image-vision-provider";
import {
  classifySourceFile,
  assertSourceContentCanBeParsed,
} from "../source-file-classifier";
import { buildSourceStorageKey } from "../storage";

type WebFetchProviderFactory = NonNullable<
  ConstructorParameters<typeof WebFetchSourceParser>[0]
>;
type WebFetchProvider = NonNullable<ReturnType<WebFetchProviderFactory>>;

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
test("json parser extracts nested string content and chunks", async () => {
  const result = await jsonSourceParser.parse({
    fileName: "data.json",
    mimeType: "application/json",
    fileSize: 43,
    content: Buffer.from(
      JSON.stringify({ title: "Hello", body: { text: "World" } }),
    ),
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
test("image document parse uses vision markdown when vision succeeds", async () => {
  const restoreVisionParser =
    documentParseTestExports.setImageVisionParserForTest(async (input) => ({
      kind: "completed",
      outcome: {
        kind: "completed",
        document: {
          title: input.fileName,
          content:
            "A chart showing revenue growth.\n\nVisible text: Q1 Revenue",
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
              content:
                "A chart showing revenue growth.\n\nVisible text: Q1 Revenue",
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
    }));
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
  const content =
    imageVisionTestExports.stripWrappingMarkdownFence(`\`\`\`markdown
# Image Description

The image features a stylized lightning bolt silhouette.

## Text
There is no visible text in the image.
\`\`\``);

  assert.equal(content.startsWith("```markdown"), false);
  assert.equal(content.endsWith("```"), false);
  assert.equal(content.includes("# Image Description"), true);
});
test("image vision failure propagates without submitting an undeclared OCR request", async () => {
  const restoreVisionParser =
    documentParseTestExports.setImageVisionParserForTest(async () => ({
      kind: "fallback",
      reason: "Default vision model gateway profile is not configured",
    }));
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
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
    await assert.rejects(
      startDocumentParse({
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
      }),
      /Default vision model gateway profile is not configured/,
    );
    assert.equal(fetchMock.mock.calls.length, 0);
  } finally {
    restoreVisionParser();
    fetchMock.mockRestore();
  }
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
test("source file classifier normalizes broad text/code files", () => {
  assert.deepEqual(
    classifySourceFile({
      fileName: "component.tsx",
      mimeType: "application/octet-stream",
    }),
    {
      supported: true,
      kind: "text",
      extension: "tsx",
      mimeType: "application/typescript",
      originalMimeType: null,
      label: "Text",
    },
  );
  assert.deepEqual(
    classifySourceFile({
      fileName: "Dockerfile",
      mimeType: "text/plain",
    }),
    {
      supported: true,
      kind: "text",
      extension: "dockerfile",
      mimeType: "text/plain",
      originalMimeType: "text/plain",
      label: "Text",
    },
  );
});
test("source file classifier normalizes image and audio files", () => {
  assert.deepEqual(
    classifySourceFile({
      fileName: "scan.tif",
      mimeType: "application/octet-stream",
    }),
    {
      supported: true,
      kind: "image",
      extension: "tif",
      mimeType: "image/tiff",
      originalMimeType: null,
      label: "Image",
    },
  );
  assert.deepEqual(
    classifySourceFile({
      fileName: "meeting.mp3",
      mimeType: "audio/mpeg",
    }),
    {
      supported: true,
      kind: "audio",
      extension: "mp3",
      mimeType: "audio/mpeg",
      originalMimeType: "audio/mpeg",
      label: "Audio",
    },
  );
  assert.deepEqual(
    classifySourceFile({
      fileName: "screen.mp4",
      mimeType: "video/mp4",
    }),
    {
      supported: true,
      kind: "audio",
      extension: "mp4",
      mimeType: "video/mp4",
      originalMimeType: "video/mp4",
      label: "Audio",
    },
  );
});
test("source file classifier rejects unsupported and conflicting files", () => {
  assert.deepEqual(
    classifySourceFile({
      fileName: "archive.zip",
      mimeType: "application/zip",
    }),
    {
      supported: false,
      extension: "zip",
      mimeType: "application/zip",
      reason: "Unsupported file extension '.zip'",
    },
  );
  assert.deepEqual(
    classifySourceFile({
      fileName: "voice.mp3",
      mimeType: "application/pdf",
    }),
    {
      supported: false,
      extension: "mp3",
      mimeType: "application/pdf",
      reason:
        "MIME type 'application/pdf' does not match file extension '.mp3'",
    },
  );
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
  const provider: WebFetchProvider = {
    name: "test-web",
    async fetch(input) {
      observedFreshValues.push(input.fresh);
      return {
        provider: "test-web",
        count: 1,
        results: [
          {
            url: input.items[0]?.url ?? "https://example.com/article",
            title: "Fetched Title",
            description: "Fetched description",
            markdown: "Fetched markdown content.",
            wordCount: 3,
            truncated: false,
          },
        ],
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
  const provider: WebFetchProvider = {
    name: "test-web",
    async fetch(input) {
      observedFreshValues.push(input.fresh);
      return {
        provider: "test-web",
        count: 1,
        results: [
          {
            url: input.items[0]?.url ?? "https://example.com/article",
            title: "Fetched Title",
            markdown: "Fetched markdown content.",
            wordCount: 3,
            truncated: false,
          },
        ],
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
        markdown:
          "<!-- Meanless: Powerful Features for Modern Web Crawling -->\n\nMain content",
      },
    },
  });

  assert.equal(
    result.content.includes("Powerful Features for Modern Web Crawling"),
    true,
  );
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

  assert.equal(
    result.content.includes("<!-- keep this internal note -->"),
    true,
  );
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

test("upload classification covers every AnyDoc extension and MIME alias", async () => {
  const { anydocFormatCatalog } =
    await import("@sourceweft/builtin-document-parsers/formats");
  for (const entry of anydocFormatCatalog) {
    for (const extension of entry.extensions) {
      for (const mimeType of [
        entry.mimeType,
        ...entry.mimeAliases,
        "application/octet-stream",
      ]) {
        const classification = classifySourceFile({
          fileName: `fixture.${extension}`,
          mimeType,
        });
        assert.equal(
          classification.supported,
          true,
          `${extension} ${mimeType}`,
        );
        if (!classification.supported) continue;
        assert.equal(classification.mimeType, entry.mimeType);
        assert.ok(getSourceParser(classification.mimeType));
      }
    }
  }
});

test("CSV upload keeps binary-content validation while binary Office files reach AnyDoc", () => {
  const binary = Buffer.from([0, 1, 0, 255, 0, 2, 0, 3]);
  for (const [fileName, mimeType] of [
    ["data.csv", "application/csv"],
    [
      "sheet.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ],
  ]) {
    const classification = classifySourceFile({ fileName, mimeType });
    assert.equal(classification.supported, true);
    if (!classification.supported) continue;
    const validate = () =>
      assertSourceContentCanBeParsed({
        classification,
        content: binary,
        fileName,
      });
    if (fileName.endsWith("csv")) assert.throws(validate, /binary|text/i);
    else assert.doesNotThrow(validate);
  }
});
