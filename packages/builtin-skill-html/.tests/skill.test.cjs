const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
test("page skill uses the common publisher and has no slide engine dependency", () => {
  const m = JSON.parse(
    fs.readFileSync(path.join(root, "sourceweft.capability.json"), "utf8"),
  );
  assert.equal(m.skills[0].runtime.output.artifactType, "html");
  assert.equal(m.skills[0].runtime.output.publisherTool, "publish_artifact");
  const script = fs.readFileSync(path.join(root, "scripts/build.cjs"), "utf8");
  assert.doesNotMatch(script, /Reveal|html-slides/);
  assert.ok(m.skills[0].runtime.tools.includes("review_html_visuals"));
});
