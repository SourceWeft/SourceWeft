import assert from "node:assert/strict";
import { test } from "vitest";
import { getBuiltinSkillBySlug, loadBuiltinSkillBundle } from "./builtin";

test("report is an opt-in discoverable skill with its own staged authoring and verification files", async () => {
  const skill = await getBuiltinSkillBySlug("report");
  assert.ok(skill, "invalid capability metadata must not silently hide report");
  assert.equal(skill.manifestJson.visibility, "public");
  assert.equal(skill.manifestJson.defaultEnabled, false);
  assert.equal(skill.manifestJson.managed, true);
  assert.equal(skill.manifestJson.slash, true);
  for (const tool of [
    "prepare_sandbox_workspace",
    "execute",
    "publish_artifact",
    "review_html_visuals",
  ])
    assert.ok(skill.manifestJson.tools?.includes(tool));
  const bundle = await loadBuiltinSkillBundle(skill.storagePointer);
  assert.ok(bundle);
  const paths = new Set(bundle.files.map((file) => file.path));
  for (const required of [
    "SKILL.md",
    "scripts/report_schema.py",
    "scripts/generate_report.py",
    "scripts/verify_report.py",
    "scripts/build-html.cjs",
    "scripts/qa-html.cjs",
    "references/report-structure.md",
    "references/evidence-and-export.md",
    "references/revision.md",
  ])
    assert.ok(paths.has(required), `Missing staged report file: ${required}`);
  const instructions =
    bundle.files.find((file) => file.path === "SKILL.md")?.contentText ?? "";
  assert.match(instructions, /report\.source\.json/);
  assert.match(instructions, /role=source\/access=private/);
  assert.match(instructions, /expectedVersionNo/);
  const wrapper =
    bundle.files.find((file) => file.path === "scripts/build-html.cjs")
      ?.contentText ?? "";
  assert.match(wrapper, /SOURCEWEFT_HTML_RUNTIME/);
  assert.doesNotMatch(wrapper, /\/skills\/html\//);
});
