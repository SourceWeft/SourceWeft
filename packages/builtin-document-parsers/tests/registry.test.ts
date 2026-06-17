import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  createDocumentProviderRegistry,
  createSourceParserRegistry,
  csvSourceParser,
  docxSourceParser,
  epubSourceParser,
  getPureSourceParser,
  isSupportedImageMimeType,
  jsonSourceParser,
  listPureSupportedSourceMimeTypes,
  pptxSourceParser,
  srtSourceParser,
  textSourceParser,
  validatePublicHttpUrl,
} from "../src/index";
import type { DocumentParseProvider } from "../src/providers";

const packageRoot = new URL("..", import.meta.url);

async function readPackageSource(relativePath: string) {
  return readFile(new URL(relativePath, packageRoot), "utf8");
}

test("pure parser registry resolves known mime types", () => {
  assert.equal(getPureSourceParser("text/markdown")?.id, "text");
  assert.equal(getPureSourceParser("application/typescript")?.id, "text");
  assert.equal(getPureSourceParser("text/csv")?.id, "csv");
  assert.equal(getPureSourceParser("application/json")?.id, "json");
  assert.equal(getPureSourceParser("application/msword")?.id, "docx");
  assert.equal(getPureSourceParser("application/epub+zip")?.id, "epub");
  assert.equal(
    getPureSourceParser(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    )?.id,
    "pptx",
  );
  assert.equal(getPureSourceParser("text/srt")?.id, "srt");
  assert.equal(getPureSourceParser("application/octet-stream"), null);
  assert.equal(listPureSupportedSourceMimeTypes().includes("text/plain"), true);
});

test("custom parser registry accepts external-owned adapters", () => {
  const registry = createSourceParserRegistry([
    {
      id: "external-owned",
      name: "External Owned Parser",
      supportedMimeTypes: ["application/pdf"],
      async parse() {
        throw new Error("not called");
      },
    },
    ...[
      docxSourceParser,
      epubSourceParser,
      csvSourceParser,
      jsonSourceParser,
      pptxSourceParser,
      srtSourceParser,
      textSourceParser,
    ],
  ]);

  assert.equal(
    registry.getSourceParser("application/pdf")?.id,
    "external-owned",
  );
  assert.equal(registry.getSourceParser("text/markdown")?.id, "text");
});

test("web URL safety rejects local and credentialed URLs", () => {
  assert.equal(
    validatePublicHttpUrl("https://example.com/article"),
    "https://example.com/article",
  );
  assert.throws(
    () => validatePublicHttpUrl("http://localhost:3000/private"),
    /URL host is not allowed/u,
  );
  assert.throws(
    () => validatePublicHttpUrl("https://user:pass@example.com/private"),
    /URL credentials are not allowed/u,
  );
});

test("image mime helper recognizes document provider image inputs", () => {
  assert.equal(isSupportedImageMimeType("image/avif"), true);
  assert.equal(isSupportedImageMimeType("image/png"), true);
  assert.equal(isSupportedImageMimeType("application/pdf"), false);
});

test("document provider registry resolves resume-capable providers", () => {
  const provider: DocumentParseProvider = {
    id: "pdf2markdown",
    supports: (mimeType) => mimeType === "application/pdf",
    async start() {
      throw new Error("not called");
    },
    async resume(token) {
      return {
        kind: "pending",
        token: { ...token, attempt: token.attempt + 1 },
      };
    },
  };
  const registry = createDocumentProviderRegistry({ pdf2markdown: provider });

  assert.equal(registry.getDocumentProvider("pdf2markdown"), provider);
  assert.equal(registry.getDocumentProviderForResume("pdf2markdown"), provider);
  assert.throws(
    () => registry.getDocumentProvider("langchain"),
    /not implemented/u,
  );
});

test("document provider registry rejects providers without resume support", () => {
  const provider: DocumentParseProvider = {
    id: "pdf2markdown",
    supports: (mimeType) => mimeType === "application/pdf",
    async start() {
      throw new Error("not called");
    },
  };
  const registry = createDocumentProviderRegistry({ pdf2markdown: provider });

  assert.throws(
    () => registry.getDocumentProviderForResume("pdf2markdown"),
    /does not support async resume/u,
  );
});

test("provider contracts avoid backend, billing, and secret terminology", async () => {
  const contractFiles = [
    join("src", "types.ts"),
    join("src", "providers", "types.ts"),
    join("src", "providers", "decision-metadata.ts"),
  ];
  const forbiddenPattern = /\b(?:backend|billing|apiKey|AnyCrawl)\b/u;
  const sources = await Promise.all(
    contractFiles.map(async (relativePath) => ({
      relativePath,
      source: await readPackageSource(relativePath),
    })),
  );

  assert.deepEqual(
    sources.flatMap(({ relativePath, source }) =>
      forbiddenPattern.test(source) ? [relativePath] : [],
    ),
    [],
  );
});
