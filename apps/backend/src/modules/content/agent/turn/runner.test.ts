import assert from "node:assert/strict";
import test from "node:test";
import { normalizeToolOutputForObservability, testExports } from "./runner";

test("normalizes read_file ToolMessage output content for observability", () => {
  const output = normalizeToolOutputForObservability("read_file", {
    type: "tool",
    lc_kwargs: {
      content: [{ text: "Path: /kb/invoice.md\nInvoice total is 50." }],
    },
    self: "[Circular]",
  });

  assert.deepEqual(output, {
    content: "Path: /kb/invoice.md\nInvoice total is 50.",
  });
});

test("preserves non-read_file tool outputs", () => {
  const output = { content: "search result", self: "[Circular]" };

  assert.equal(
    normalizeToolOutputForObservability("search_sources", output),
    output,
  );
});

test("normalizes web tool outputs to display-safe metadata", () => {
  const output = normalizeToolOutputForObservability(
    "web_search",
    "Use these web search results internally.\n\n<web_result id='c1' rank='1' url='https://example.com/a' title='A'>Snippet</web_result>",
  );

  assert.deepEqual(output, {
    resultCount: 1,
    urlCount: 1,
    urls: ["https://example.com/a"],
    pages: [
      {
        url: "https://example.com/a",
        title: "A",
        rank: 1,
        citation: "c1",
        hasContent: false,
      },
    ],
    truncated: false,
  });
  assert.equal(
    JSON.stringify(output).includes("Use these web search results internally"),
    false,
  );
});

test("normalizes web_search failure outputs to display-safe metadata", () => {
  const output = normalizeToolOutputForObservability(
    "web_search",
    "web_search failed.\n\n<web_tool_error tool='web_search' provider='anycrawl' query='Shanghai weather' error='API Error 500: Internal server error'></web_tool_error>",
  );

  assert.deepEqual(output, {
    errorCount: 1,
    error: "API Error 500: Internal server error",
    query: "Shanghai weather",
    urlCount: 0,
    urls: [],
    truncated: false,
  });
});

test("normalizes all-failed web_fetch outputs to display-safe metadata", () => {
  const output = normalizeToolOutputForObservability(
    "web_fetch",
    "<web_page rank='1' url='https://example.com' error='API Error 500: Internal server error'></web_page>",
  );

  assert.deepEqual(output, {
    pageCount: 1,
    errorCount: 1,
    urlCount: 1,
    urls: ["https://example.com"],
    pages: [
      {
        url: "https://example.com",
        rank: 1,
        error: "API Error 500: Internal server error",
        hasContent: true,
      },
    ],
    truncated: false,
  });
});

test("filesystem tool titles classify glob scope from mounted pattern", () => {
  assert.equal(
    testExports.getFilesystemToolStartTitle("glob", { path: "/", pattern: "/work/**/*.md" }),
    "Finding matching Workfiles",
  );
  assert.equal(
    testExports.getFilesystemToolEndTitle("glob", { path: "/", pattern: "/skills/**/*.md" }),
    "Found matching skill files",
  );
  assert.equal(
    testExports.getFilesystemToolDescription(
      "read_file",
      { chunkCount: 1 },
      { path: "/work/notes.md" },
    ),
    "Read 1 Workfile chunk.",
  );
  assert.equal(
    testExports.getFilesystemToolDescription(
      "read_file",
      { chunkCount: 1 },
      { path: "/kb/source.md", limit: 100 },
    ),
    "Read up to 100 source lines.",
  );
});

test("runtime prompt maps selected source mention labels to kb paths", () => {
  const prompt = testExports.buildAgentRuntimePrompt({
    timezone: "UTC",
    availableWebTools: [],
    selectedSources: [
      {
        sourceId: "043e27f7-c8e0-438e-a47f-adcf8b06088e",
        sourceType: "file_upload",
        parentSourceId: null,
        title: "043e27f7-c8e0-438e-a47f-adcf8b06088e.pdf",
        fileName: "043e27f7-c8e0-438e-a47f-adcf8b06088e.pdf",
        safeName: "043e27f7-c8e0-438e-a47f-adcf8b06088e",
        shortId: "043e27f7",
        filePath: "/kb/043e27f7-c8e0-438e-a47f-adcf8b06088e__src_043e27f7.md",
        dirPath: "/kb/043e27f7-c8e0-438e-a47f-adcf8b06088e__src_043e27f7",
        readmePath: null,
        chunkCount: 4,
        sizeBytes: 12000,
        mimeType: "application/pdf",
        updatedAt: "2026-05-09T00:00:00.000Z",
      },
    ],
    selectedSourcesOmitted: 0,
  });

  assert.match(prompt, /<selected_source_manifest>/);
  assert.match(prompt, /@043e27f7-c8e0-438e-a47f-adcf8b06088e\.pdf/);
  assert.match(prompt, /kb_path="\/kb\/043e27f7-c8e0-438e-a47f-adcf8b06088e__src_043e27f7\.md"/);
  assert.match(prompt, /Do not synthesize \/work\/<filename>/);
  assert.match(prompt, /\/work contains only thread Workfiles/);
});

test("runtime prompt lists only available public web tools", () => {
  const fetchOnlyPrompt = testExports.buildAgentRuntimePrompt({
    timezone: "UTC",
    availableWebTools: ["web_fetch"],
  });
  assert.match(fetchOnlyPrompt, /Available public web tools this turn: web_fetch\./);
  assert.doesNotMatch(fetchOnlyPrompt, /web_search and web_fetch/);

  const searchAndFetchPrompt = testExports.buildAgentRuntimePrompt({
    timezone: "UTC",
    availableWebTools: ["web_search", "web_fetch"],
  });
  assert.match(
    searchAndFetchPrompt,
    /Available public web tools this turn: web_search, web_fetch\./,
  );
});
