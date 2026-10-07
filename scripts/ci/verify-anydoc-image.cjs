"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { spawnSync } = require("node:child_process");

const image = process.argv[2];
assert.ok(
  image && !image.startsWith("-"),
  "Provide the production image to verify",
);
const fixture = readFileSync(
  resolve(
    __dirname,
    "../../packages/anydoc/tests/fixtures/standalone-quantity.pdf",
  ),
);
const script = `
const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const parserRequire = createRequire('/app/packages/builtin-document-parsers/package.json');
const anydoc = parserRequire('@sourceweft/anydoc');
const receipt = JSON.parse(readFileSync('/app/packages/anydoc/native/build.json', 'utf8'));
assert.equal(receipt.upstreamVersion, '0.2.4');
assert.equal(receipt.architecture, process.arch);
assert.equal(receipt.platform, process.platform);
assert.equal(receipt.sha256, createHash('sha256').update(readFileSync('/app/packages/anydoc/native/bindings.node')).digest('hex'));
for (const path of ['upstream', 'tests', 'scripts']) {
  assert.equal(existsSync('/app/packages/anydoc/' + path), false, path + ' must not ship in runtime');
}
assert.throws(() => parserRequire.resolve('@firecrawl/anydoc'), { code: 'MODULE_NOT_FOUND' });
(async () => {
  const bytes = readFileSync(0);
  assert.equal(anydoc.formatFromBytes(bytes), 'pdf');
  const markdown = await anydoc.toMarkdownBytes(bytes, 'pdf', { ocr: 'reject' });
  for (const fact of ['RC4-PDF-9799CF2BB49AFEF18315339B', 'Delft', 'USD 2745.00']) {
    assert.ok(markdown.includes(fact), 'Original PDF fact missing: ' + fact);
  }
  assert.match(markdown, /Number of boxes\\s+39(?:\\s|$)/);
  console.log(JSON.stringify({ architecture: process.arch, bindingSha256: receipt.sha256, numericPdfPreserved: true, runtimeBuildSourcesAbsent: true, officialBugBindingAbsent: true }));
})().catch((error) => { console.error(error); process.exitCode = 1; });
`;
const result = spawnSync(
  "docker",
  [
    "run",
    "--rm",
    "-i",
    "--network",
    "none",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=8m",
    "--entrypoint",
    "node",
    image,
    "-e",
    script,
  ],
  { input: fixture, encoding: "utf8", timeout: 120000, maxBuffer: 1024 * 1024 },
);
if (result.error) throw result.error;
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
assert.equal(
  result.status,
  0,
  "Actual production image AnyDoc verification failed",
);
