import assert from "node:assert/strict";
import { test } from "vitest";
import { capLength, parseJsonObject, toPlainText } from "./text";

test("toPlainText drops markup, links' targets, URLs and control characters", () => {
  assert.equal(
    toPlainText(
      "## Title\n- **Bold** [docs](https://example.com) ![logo](x.png) <b>tag</b> `code` see https://evil.example/path\u0000",
    ),
    "Title Bold docs logo tag code see",
  );
});

test("capLength cuts at a word boundary near the end, by code point", () => {
  assert.equal(capLength("alpha beta gamma delta", 15), "alpha beta…");
  assert.equal(capLength("short", 15), "short");
  // CJK has no spaces: cut at the limit without splitting a character.
  assert.equal(capLength("资料库伺服器设定", 5), "资料库伺…");
});

test("parseJsonObject reads a fenced or bare object and rejects anything else", () => {
  assert.deepEqual(parseJsonObject('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonObject('Here: {"a":{"b":2}} done'), {
    a: { b: 2 },
  });
  assert.equal(parseJsonObject("no json here"), null);
  assert.equal(parseJsonObject("{broken"), null);
});
