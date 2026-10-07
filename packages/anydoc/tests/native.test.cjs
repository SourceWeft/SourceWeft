"use strict";
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const native = require("../anydoc.js");
test("original shipping PDF preserves all four facts through the maintained AnyDoc NAPI API", async () => {
  const bytes = readFileSync(
    join(__dirname, "fixtures/standalone-quantity.pdf"),
  );
  assert.equal(native.formatFromBytes(bytes), "pdf");
  const markdown = await native.toMarkdownBytes(bytes, "pdf", {
    ocr: "reject",
  });
  for (const value of [
    "RC4-PDF-9799CF2BB49AFEF18315339B",
    "Delft",
    "USD 2745.00",
  ])
    assert.ok(markdown.includes(value));
  assert.match(markdown, /Number of boxes\s+39(?:\s|$)/);
});
test("numeric body values and genuine page footers are retained rather than ambiguously deleted", async () => {
  const bytes = readFileSync(
    join(__dirname, "fixtures/body-integers-and-page-footer.pdf"),
  );
  const markdown = await native.toMarkdownBytes(bytes, "pdf", {
    ocr: "reject",
  });
  for (const value of ["39", "0", "9999"])
    assert.match(markdown, new RegExp(`Quantity\\s+${value}(?:\\s|$)`));
  for (let i = 1; i <= 3; i++) assert.ok(markdown.includes(`Page ${i} of 3`));
});

test("runtime without its maintained binding fails without loading a different parser binary", () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const { execFileSync } = require("node:child_process");
  const directory = mkdtempSync(join(tmpdir(), "sourceweft-anydoc-missing-"));
  try {
    writeFileSync(
      join(directory, "index.js"),
      readFileSync(join(__dirname, "../index.js")),
    );
    const upstream = join(directory, "node_modules/@firecrawl/anydoc");
    mkdirSync(upstream, { recursive: true });
    writeFileSync(
      join(upstream, "index.js"),
      'throw new Error("UNPATCHED_UPSTREAM_WAS_LOADED")',
    );
    const output = execFileSync(
      process.execPath,
      [
        "-e",
        `try { require(${JSON.stringify(join(directory, "index.js"))}); process.exit(2); } catch(error) { if (!error.message.includes("Maintained AnyDoc native binding is unavailable")) throw error; console.log("maintained-binding-required"); }`,
      ],
      { encoding: "utf8" },
    );
    assert.match(output, /maintained-binding-required/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
