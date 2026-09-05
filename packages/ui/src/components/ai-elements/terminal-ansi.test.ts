import { expect, test } from "vitest";
import { parseTerminalAnsi } from "./terminal-ansi";

// Asserted with vitest's `expect` rather than `node:assert`: this is a browser
// component library, and it declares no `@types/node`. The Node import only
// type-checked on machines that happened to have `@types/node` installed
// somewhere above the repo, so CI failed on it while every local run passed.

test("preserves plain terminal output as text", () => {
  expect(parseTerminalAnsi("hello <script>alert(1)</script>")).toEqual([
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

  expect(segments[0]?.content).toBe("red");
  expect(segments[0]?.style.color).toBe("rgb(187, 0, 0)");
  expect(segments.at(-1)?.content).toBe("bold");
  expect(segments.at(-1)?.style.fontWeight).toBe("bold");
});

test("applies terminal carriage returns and backspaces", () => {
  expect(
    parseTerminalAnsi("progress 10%\rprogress 90%\nabc\bZ")
      .map((segment) => segment.content)
      .join(""),
  ).toBe("progress 90%\nabZ");
});
