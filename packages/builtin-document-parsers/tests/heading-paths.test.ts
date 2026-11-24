import assert from "node:assert/strict";
import { test } from "node:test";
import { chunkSourceContent } from "../src/index";
import { headingPathOf, markdownSections } from "../src/heading-paths";

test("sections carry the path of their heading and its ancestors", () => {
  const text = [
    "Preamble line.",
    "# Guide",
    "Intro.",
    "## Install",
    "Steps.",
    "### On macOS ###",
    "Brew.",
    "## Use",
    "Run it.",
    "# Appendix",
  ].join("\n");

  assert.deepEqual(
    markdownSections(text).map((section) => section.path),
    [
      null,
      "Guide",
      "Guide > Install",
      "Guide > Install > On macOS",
      "Guide > Use",
      "Appendix",
    ],
  );
});

test("hash lines inside fenced code, and hashes without a space, are not headings", () => {
  const text = [
    "# Real",
    "```sh",
    "# a shell comment",
    "```",
    "~~~~",
    "## still code",
    "```",
    "~~~~",
    "#hashtag",
    "    # indented code",
    "## Next",
  ].join("\n");

  assert.deepEqual(
    markdownSections(text).map((section) => section.path),
    ["Real", "Real > Next"],
  );
});

test("a chunk takes the section that holds most of its text", () => {
  const text = `# One\n${"a".repeat(100)}\n# Two\n${"b".repeat(300)}`;
  const sections = markdownSections(text);
  const twoStart = text.indexOf("# Two");

  assert.equal(headingPathOf(sections, 0, twoStart + 20), "One");
  assert.equal(headingPathOf(sections, twoStart - 20, text.length), "Two");
  assert.equal(headingPathOf(markdownSections("no headings here"), 0, 16), null);
});

test("chunks of a markdown document record their section paths", async () => {
  const body = (word: string) => `${word} `.repeat(120).trim();
  const content = [
    "# CLI",
    body("intro"),
    "## Commands",
    body("commands"),
    "## Exit codes",
    body("codes"),
    "### Details",
    body("details"),
  ].join("\n\n");

  const chunks = await chunkSourceContent(content, { chunkSize: 700 });
  const paths = chunks.map((chunk) => chunk.headingPath);

  assert.equal(paths[0], "CLI");
  assert.ok(paths.includes("CLI > Commands"));
  assert.ok(paths.includes("CLI > Exit codes"));
  assert.equal(paths.at(-1), "CLI > Exit codes > Details");
  for (const chunk of chunks) {
    const word = chunk.text.split(/\s+/).find((token) => !token.startsWith("#"));
    if (word === "commands") assert.equal(chunk.headingPath, "CLI > Commands");
  }
});

test("plain text chunks have no heading path", async () => {
  const chunks = await chunkSourceContent("Just a note without headings.");
  assert.equal(chunks.length, 1);
  assert.equal("headingPath" in chunks[0]!, false);
});
