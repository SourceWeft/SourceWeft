import assert from "node:assert/strict";
import test from "node:test";
import { normalizeToolOutputForObservability } from "./runner";

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
