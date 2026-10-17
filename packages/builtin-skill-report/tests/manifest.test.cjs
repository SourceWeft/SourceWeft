const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
test("pure report capability uses existing HTML runtime and artifact tools with no default activation", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "sourceweft.capability.json"), "utf8"),
  );
  assert.equal(manifest.id, "sourceweft/report");
  assert.equal(manifest.skills[0].visibility, "public");
  assert.equal(manifest.skills[0].defaultEnabled, false);
  assert.equal(manifest.skills[0].managed, true);
  assert.equal(manifest.skills[0].slash, true);
  assert.equal(manifest.skills[0].runtime.output.artifactType, "html");
  assert.equal(
    manifest.skills[0].runtime.output.publisherTool,
    "publish_artifact",
  );
  const source = fs.readFileSync(path.join(root, "SKILL.md"), "utf8");
  assert.match(source, /name: report/);
  assert.match(source, /expectedVersionNo/);
  assert.match(source, /access=private/);
  const build = fs.readFileSync(
    path.join(root, "scripts/build-html.cjs"),
    "utf8",
  );
  assert.match(build, /SOURCEWEFT_HTML_RUNTIME/);
  assert.match(build, /bundle\.cjs/);
  assert.doesNotMatch(build, /\/skills\/html\//);
});
