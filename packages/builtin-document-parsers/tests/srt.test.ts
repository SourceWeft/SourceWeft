import assert from "node:assert/strict";
import { test } from "node:test";
import { srtSourceParser } from "../src/srt";

// Golden outputs captured from the removed SRTLoader + createLoaderParser
// before removal. This preserves its behavior, including BOM/timestamp quirks.
const cases = [
  {
    name: "caption order, Chinese, inline markup and multiline text",
    input:
      "1\n00:00:01,000 --> 00:00:02,000\n你好 <i>world</i>\nsecond line\n\n2\n00:00:02,100 --> 00:00:03,000\nNext caption\n",
    content: "你好 <i>world</i>\nsecond line Next caption",
    wordCount: 6,
    charCount: 40,
    tokenCount: 10,
  },
  {
    name: "existing BOM, CRLF and alternate timestamp behavior",
    input:
      "\uFEFF1\r\n00:00:00.500 --> 00:00:01.900\r\nA &amp; B\r\n\r\n2\r\n00:00:02,000 --> 00:00:03,000\r\nC\r\n",
    content: "C",
    wordCount: 1,
    charCount: 1,
    tokenCount: 1,
  },
  {
    name: "malformed input",
    input: "not subtitles",
    content: "",
    wordCount: 0,
    charCount: 0,
    tokenCount: 0,
  },
  {
    name: "empty input",
    input: "",
    content: "",
    wordCount: 0,
    charCount: 0,
    tokenCount: 0,
  },
];

for (const fixture of cases) {
  test(`direct SRT parser preserves ${fixture.name}`, async () => {
    const result = await srtSourceParser.parse({
      content: Buffer.from(fixture.input),
      fileName: "captions.srt",
      mimeType: "text/srt",
      fileSize: Buffer.byteLength(fixture.input),
      config: { chunkSize: 512, parserVersion: "parity" },
    });
    assert.equal(result.content, fixture.content);
    assert.equal(result.metadata.wordCount, fixture.wordCount);
    assert.equal(result.metadata.charCount, fixture.charCount);
    assert.equal(result.metadata.pageCount, fixture.content ? 1 : 0);
    assert.deepEqual(
      result.pages,
      fixture.content ? [{ pageNumber: 1, content: fixture.content }] : [],
    );
    assert.deepEqual(
      result.chunks,
      fixture.content
        ? [
            {
              text: fixture.content,
              startIndex: 0,
              endIndex: fixture.charCount,
              tokenCount: fixture.tokenCount,
            },
          ]
        : [],
    );
    assert.equal(result.title, "captions.srt");
  });
}
