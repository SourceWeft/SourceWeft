import assert from "node:assert/strict";
import test from "node:test";
import { AgentCitationRegistry } from "./citation-registry";
import {
  DatabaseKnowledgeBackend,
  addInlineSourceMarkers,
  buildGrepGlobMatcher,
  computeLineStartOffsets,
  paginateSourceContent,
  matchesGrepGlob,
  normalizeGrepGlobPattern,
} from "./database-fs-backend";

test("normalizeGrepGlobPattern anchors relative glob to grep path", () => {
  assert.equal(normalizeGrepGlobPattern("*.md", "/kb"), "/kb/*.md");
  assert.equal(
    normalizeGrepGlobPattern("*.md", "/kb/source__src_12345678"),
    "/kb/source__src_12345678/*.md",
  );
});

test("DatabaseKnowledgeBackend readRaw is disabled to avoid hidden citation registration", async () => {
  const citationRegistry = new AgentCitationRegistry();
  const backend = new DatabaseKnowledgeBackend({
    teamId: "team-1",
    workspaceId: "workspace-1",
    sourceIds: ["source-1"],
    citationRegistry,
  });

  const result = await backend.readRaw("/kb/source.md");

  assert.match(result.error ?? "", /raw downloads are disabled/);
  assert.equal(citationRegistry.list().length, 0);
});

test("paginateSourceContent uses source lines instead of chunk windows", () => {
  const content = [
    "line 1",
    "line 2",
    "line 3",
    "line 4",
    "line 5",
  ].join("\n");

  const page = paginateSourceContent(content, 1, 2);

  assert.equal(page.text, "line 2\nline 3");
  assert.equal(page.startLine, 2);
  assert.equal(page.endLine, 3);
  assert.equal(page.totalLines, 5);
  assert.equal(page.nextOffset, 3);
  assert.equal(content.slice(page.pageStartOffset, page.pageEndOffset), "line 2\nline 3\n");
});

test("paginateSourceContent defaults to 100 source lines and caps explicit limits", () => {
  const content = Array.from({ length: 1200 }, (_, index) => `line ${index + 1}`).join("\n");

  const defaultPage = paginateSourceContent(content);
  assert.equal(defaultPage.startLine, 1);
  assert.equal(defaultPage.endLine, 100);
  assert.equal(defaultPage.nextOffset, 100);

  const cappedPage = paginateSourceContent(content, 0, 5000);
  assert.equal(cappedPage.endLine, 1000);
  assert.equal(cappedPage.nextOffset, 1000);
});

test("paginateSourceContent keeps offsets aligned with CRLF source content", () => {
  const content = "alpha\r\nbravo\r\ncharlie";

  const page = paginateSourceContent(content, 1, 1);

  assert.equal(page.text, "bravo");
  assert.equal(page.pageStartOffset, 7);
  assert.equal(page.pageEndOffset, 14);
  assert.equal(content.slice(page.pageStartOffset, page.pageEndOffset), "bravo\r\n");
});

test("addInlineSourceMarkers annotates overlapping chunks without duplicating source text", () => {
  const content = "alpha\nbravo\ncharlie\ndelta";
  const marked = addInlineSourceMarkers({
    text: "bravo\ncharlie",
    startLine: 2,
    nextOffset: 3,
    sourcePath: "/kb/source.md",
    limit: 2,
    lineStartOffsets: computeLineStartOffsets(content),
    citations: [
      {
        citation: "c1",
        chunk: {
          sourceId: "source-1",
          sourceTitle: "Source",
          sourceFileName: "source.md",
          documentId: "document-1",
          chunkId: "chunk-1",
          chunkNo: 0,
          content: "alpha\nbravo",
          startOffset: 0,
          endOffset: 11,
          headingPath: null,
          language: "markdown",
        },
      },
      {
        citation: "c2",
        chunk: {
          sourceId: "source-1",
          sourceTitle: "Source",
          sourceFileName: "source.md",
          documentId: "document-1",
          chunkId: "chunk-2",
          chunkNo: 1,
          content: "bravo\ncharlie",
          startOffset: 6,
          endOffset: 19,
          headingPath: null,
          language: "markdown",
        },
      },
    ],
  });

  assert.equal(
    marked,
    'bravo [citation:c1] [citation:c2]\ncharlie [Output truncated. Continue with read_file(file_path: "/kb/source.md", offset: 3, limit: 2).]',
  );
  assert.equal(marked.includes("alpha\nbravo\nbravo"), false);
});

test("buildGrepGlobMatcher lets source-file globs select chunk-backed content", () => {
  const matcher = buildGrepGlobMatcher("*.md", "/kb");

  assert.equal(matcher.test("/kb/invoice__src_12345678.md"), true);
  assert.equal(matcher.test("/kb/invoice__src_12345678/chunks/0000.md"), false);
  assert.equal(
    matchesGrepGlob({
      glob: "*.md",
      globMatcher: matcher,
      sourceFilePath: "/kb/invoice__src_12345678.md",
      chunkPath: "/kb/invoice__src_12345678/chunks/0000.md",
    }),
    true,
  );
});

test("buildGrepGlobMatcher treats bare star as the current grep scope", () => {
  const matcher = buildGrepGlobMatcher("*", "/kb");

  assert.equal(normalizeGrepGlobPattern("*", "/kb"), "**");
  assert.equal(matcher.test("/kb/invoice__src_12345678.md"), true);
  assert.equal(matcher.test("/kb/invoice__src_12345678/chunks/0000.md"), true);
  assert.equal(
    matchesGrepGlob({
      glob: "*",
      globMatcher: matcher,
      sourceFilePath: "/kb/invoice__src_12345678.md",
      chunkPath: "/kb/invoice__src_12345678/chunks/0000.md",
    }),
    true,
  );
});

test("buildGrepGlobMatcher does not expose original source title aliases", () => {
  const matcher = buildGrepGlobMatcher("*.pdf", "/kb");

  assert.equal(normalizeGrepGlobPattern("*.pdf", "/kb"), "/kb/*.pdf");
  assert.equal(matcher.test("/kb/invoice.pdf"), true);
  assert.equal(matcher.test("/kb/invoice__src_12345678.md"), false);
  assert.equal(
    matchesGrepGlob({
      glob: "*.pdf",
      globMatcher: matcher,
      sourceFilePath: "/kb/invoice__src_12345678.md",
      chunkPath: "/kb/invoice__src_12345678/chunks/0000.md",
    }),
    false,
  );
});

test("buildGrepGlobMatcher preserves recursive chunk globs", () => {
  const matcher = buildGrepGlobMatcher("**/*.md", "/kb");

  assert.equal(matcher.test("/kb/invoice__src_12345678.md"), true);
  assert.equal(matcher.test("/kb/invoice__src_12345678/chunks/0000.md"), true);
});

test("buildGrepGlobMatcher keeps non-matching globs selective", () => {
  const matcher = buildGrepGlobMatcher("contract*.md", "/kb");

  assert.equal(matcher.test("/kb/invoice__src_12345678.md"), false);
  assert.equal(
    matchesGrepGlob({
      glob: "contract*.md",
      globMatcher: matcher,
      sourceFilePath: "/kb/invoice__src_12345678.md",
      chunkPath: "/kb/invoice__src_12345678/chunks/0000.md",
    }),
    false,
  );
});

test("matchesGrepGlob allows all chunks when glob is omitted", () => {
  const matcher = buildGrepGlobMatcher(null, "/kb");

  assert.equal(
    matchesGrepGlob({
      glob: null,
      globMatcher: matcher,
      sourceFilePath: "/kb/invoice__src_12345678.md",
      chunkPath: "/kb/invoice__src_12345678/chunks/0000.md",
    }),
    true,
  );
});
