import assert from "node:assert/strict";
import { test } from "vitest";
import { getBuiltinSkillBySlug, loadBuiltinSkillBundle } from "./builtin";

test("ppt-deck builtin skill stays hidden from the public gallery", async () => {
  const skill = await getBuiltinSkillBySlug("ppt-deck");

  assert.ok(skill);
  assert.equal(skill.visibility, "restricted");
  assert.equal(skill.manifestJson.visibility, "restricted");
  assert.equal(skill.manifestJson.slash, false);
  assert.deepEqual(skill.manifestJson.slashConfig, { enabled: false });
  assert.deepEqual(skill.manifestJson.tools, ["generate_pptx", "generate_image"]);
});

test("ppt-deck builtin skill includes editable native object hygiene guidance", async () => {
  const skill = await getBuiltinSkillBySlug("ppt-deck");
  assert.ok(skill);
  const bundle = await loadBuiltinSkillBundle(skill.storagePointer);
  const content = bundle?.files.find((file) => file.path === "SKILL.md")
    ?.contentText;

  assert.match(content ?? "", /Native Editable PPTX Contract/);
  assert.match(content ?? "", /blank cards, empty media frames/);
  assert.match(content ?? "", /editable_native_empty_shape/);
});
