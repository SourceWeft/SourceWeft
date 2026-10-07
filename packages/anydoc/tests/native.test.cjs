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

test("real CSV and DOCX conversion matches the official AnyDoc 0.2.4 native baseline", async () => {
  const { createHash } = require("node:crypto");
  const baseline = JSON.parse(
    readFileSync(
      join(__dirname, "fixtures/non-pdf-upstream-baselines.json"),
      "utf8",
    ),
  );
  assert.equal(baseline.upstreamVersion, "0.2.4");
  for (const record of baseline.records) {
    const bytes = readFileSync(join(__dirname, "fixtures", record.file));
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      record.fixtureSha256,
    );
    const markdown = await native.toMarkdownBytes(bytes, record.format, {
      ocr: "reject",
    });
    assert.equal(markdown, record.markdown);
    assert.equal(
      createHash("sha256").update(markdown).digest("hex"),
      record.markdownSha256,
    );
  }
});

test("the build receipt binds the actual binary and maintained license notices", () => {
  const { createHash } = require("node:crypto");
  const receipt = JSON.parse(
    readFileSync(join(__dirname, "../native/build.json"), "utf8"),
  );
  assert.equal(
    receipt.upstreamCommit,
    "42bf1c5ecdde9eb0d96d6bd75a9e6698cf93b14c",
  );
  assert.equal(receipt.pdfInspectorVersion, "1.14.2");
  assert.equal(
    receipt.sha256,
    createHash("sha256")
      .update(readFileSync(join(__dirname, "../native/bindings.node")))
      .digest("hex"),
  );
  assert.equal(
    receipt.licenseNoticesSha256,
    createHash("sha256")
      .update(readFileSync(join(__dirname, "../THIRD_PARTY_NOTICES.txt")))
      .digest("hex"),
  );
});

test("tampered pinned source fails before any Rust build is invoked", () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const { spawnSync } = require("node:child_process");
  const directory = mkdtempSync(
    join(tmpdir(), "sourceweft-anydoc-source-check-"),
  );
  try {
    mkdirSync(join(directory, "scripts"));
    writeFileSync(
      join(directory, "scripts/build-native.cjs"),
      readFileSync(join(__dirname, "../scripts/build-native.cjs")),
    );
    const manifest = JSON.parse(
      readFileSync(join(__dirname, "../UPSTREAM.json"), "utf8"),
    );
    writeFileSync(join(directory, "UPSTREAM.json"), JSON.stringify(manifest));
    const file = join(directory, "upstream", manifest.files[0].path);
    mkdirSync(require("node:path").dirname(file), { recursive: true });
    writeFileSync(file, "tampered source");
    const result = spawnSync(
      process.execPath,
      [join(directory, "scripts/build-native.cjs")],
      { encoding: "utf8", env: { ...process.env, PATH: "" } },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Pinned AnyDoc source checksum mismatch/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
