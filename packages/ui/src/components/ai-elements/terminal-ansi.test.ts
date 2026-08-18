import assert from "node:assert/strict";
import { test } from "vitest";
import { parseTerminalAnsi } from "./terminal-ansi";

test("preserves plain terminal output as text", () => {
  assert.deepEqual(parseTerminalAnsi("hello <script>alert(1)</script>"), [
    {
      content: "hello <script>alert(1)</script>",
      style: {},
    },
  ]);
});

test("converts ANSI colors and decorations into React styles", () => {
  const segments = parseTerminalAnsi(
    "\u001b[31mred\u001b[0m \u001b[1mbold\u001b[0m",
  );

  assert.equal(segments[0]?.content, "red");
  assert.equal(segments[0]?.style.color, "rgb(187, 0, 0)");
  assert.equal(segments.at(-1)?.content, "bold");
  assert.equal(segments.at(-1)?.style.fontWeight, "bold");
});

test("applies terminal carriage returns and backspaces", () => {
  assert.equal(
    parseTerminalAnsi("progress 10%\rprogress 90%\nabc\bZ")
      .map((segment) => segment.content)
      .join(""),
    "progress 90%\nabZ",
  );
});
