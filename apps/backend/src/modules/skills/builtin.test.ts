import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "vitest";
import {
  getBuiltinSkillBySlug,
  listBuiltinSkills,
  loadBuiltinSkillBundle,
} from "./builtin";

const legacyBuiltinSkillsDir = resolve(import.meta.dirname, "builtin");

test("builtin skills load from standalone capability packages", async () => {
  const skills = await listBuiltinSkills();
  const bySlug = new Map(skills.map((skill) => [skill.slug, skill]));

  assert.deepEqual(
    ["feynman", "meeting-summary", "ppt-deck"].map((slug) => bySlug.has(slug)),
    [true, true, true],
  );

  for (const slug of ["feynman", "meeting-summary", "ppt-deck"]) {
    assert.match(
      bySlug.get(slug)?.storagePointer ?? "",
      /^capability-package:sourceweft\//,
    );
  }

  const feynmanBundle = await loadBuiltinSkillBundle(
    bySlug.get("feynman")?.storagePointer ?? "",
  );
  assert.ok(feynmanBundle);
  assert.equal(bySlug.get("feynman")?.manifestJson.commands, undefined);
  assert.equal(bySlug.get("feynman")?.manifestJson.slash, true);
  assert.equal(existsSync(legacyBuiltinSkillsDir), false);
});

test("ppt-deck builtin skill stays hidden from the public gallery", async () => {
  const skill = await getBuiltinSkillBySlug("ppt-deck");

  assert.ok(skill);
  assert.equal(skill.visibility, "restricted");
  assert.equal(skill.manifestJson.visibility, "restricted");
  assert.equal(skill.manifestJson.slash, false);
  assert.deepEqual(skill.manifestJson.tools, [
    "prepare_sandbox_workspace",
    "execute",
    "publish_sandbox_artifact",
  ]);
  assert.deepEqual(
    skill.manifestJson.options?.map((option) => option.id),
    ["stylePreset", "visualDensity", "slideCount", "language"],
  );
  assert.deepEqual(skill.manifestJson.options?.[0]?.target, {
    path: "runtime.config.stylePreset",
  });
});

test("ppt-deck builtin skill includes sandbox-based generation guidance", async () => {
  const skill = await getBuiltinSkillBySlug("ppt-deck");
  assert.ok(skill);
  const bundle = await loadBuiltinSkillBundle(skill.storagePointer);
  const content = bundle?.files.find(
    (file) => file.path === "SKILL.md",
  )?.contentText;
  const bundledContent = bundle?.files
    .map((file) => file.contentText)
    .join("\n\n");

  assert.match(content ?? "", /pptxgenjs/);
  assert.doesNotMatch(content ?? "", new RegExp(["sourceweft", ":"].join("")));
  assert.match(content ?? "", /sandbox/);
  assert.doesNotMatch(content ?? "", /slides\.json/);
  assert.match(content ?? "", /\/workfiles\/ppt-deck\/deck\.js/);
  assert.match(content ?? "", /\/workspace\/ppt-deck\/deck\.js/);
  assert.match(content ?? "", /Quick Reference/);
  assert.match(content ?? "", /Reading Content/);
  assert.match(content ?? "", /Editing Workflow/);
  assert.match(content ?? "", /Creating From Scratch/);
  assert.match(content ?? "", /Design Ideas/);
  assert.match(content ?? "", /QA Required/);
  assert.match(content ?? "", /Converting To Images/);
  assert.match(content ?? "", /Dependencies/);
  assert.match(content ?? "", /node --check \/workspace\/ppt-deck\/deck\.js/);
  assert.match(content ?? "", /node \/workspace\/ppt-deck\/deck\.js/);
  assert.match(content ?? "", /Required reads/);
  assert.match(
    content ?? "",
    /Before creating, editing, writing, preparing, or executing any PPTX\s+generation code, read \[pptxgenjs\.md\]/,
  );
  assert.match(
    content ?? "",
    /Do not write\s+`\/workfiles\/ppt-deck\/deck\.js`, call `prepare_sandbox_workspace`, or run\s+`execute`/,
  );
  assert.match(
    content ?? "",
    /Before retrying after a syntax, runtime, rendering, output-path, or QA\s+failure, read \[pitfalls\.md\]/,
  );
  assert.match(
    content ?? "",
    /mandatory and must happen before `node \/workspace\/ppt-deck\/deck\.js`/,
  );
  assert.match(content ?? "", /publish_sandbox_artifact/);
  assert.match(content ?? "", /artifactType: "slides"/);
  assert.match(content ?? "", /PPTX_ARTIFACT_PATH/);
  assert.match(content ?? "", /PPTX_ARTIFACT_BYTES/);
  assert.match(
    content ?? "",
    /PPTX_ARTIFACT_PATH` must be a complete absolute sandbox path ending in\s+`\.pptx`/,
  );
  assert.match(content ?? "", /fs\.mkdirSync\(OUTPUT_DIR, \{ recursive: true \}\)/);
  assert.match(content ?? "", /await pres\.writeFile\(\{ fileName: PPTX_PATH \}\)/);
  assert.match(
    content ?? "",
    /PPTX generated: \/workspace\/ppt-deck\/output\/deck-slug\.pptx/,
  );
  assert.match(content ?? "", /source of truth for QA and publishing/);
  assert.doesNotMatch(content ?? "", /deckData/);
  assert.match(content ?? "", /JSON\.stringify\(value\)/);
  assert.match(content ?? "", /safe literal\s+strategy/);
  assert.match(content ?? "", /const text = \(value\) => String\(value \?\? ""\)/);
  assert.match(content ?? "", /Do not inline Chinese\s+or quoted prose into JavaScript string literals/);
  assert.match(content ?? "", /minimal repair mode/);
  assert.match(content ?? "", /line\/column/);
  assert.match(content ?? "", /visual direction|Design Ideas/);
  assert.match(content ?? "", /Vary layouts/);
  assert.match(content ?? "", /promised visual elements/);
  assert.match(content ?? "", /reliable asset is\s+unavailable/);
  assert.doesNotMatch(content ?? "", /backgroundMode/);
  assert.doesNotMatch(content ?? "", /renderBackground/);
  assert.doesNotMatch(content ?? "", /applyBackground/);
  assert.doesNotMatch(content ?? "", /role\s*\/\s*visualIntent/);
  assert.doesNotMatch(content ?? "", /Feynman Method/);
  assert.doesNotMatch(content ?? "", /feynman-method\.pptx/);
  assert.match(content ?? "", /\/workspace\/ppt-deck\/qa/);
  assert.match(content ?? "", /Use the exact path printed by `PPTX_ARTIFACT_PATH/);
  assert.match(content ?? "", /pdftoppm/);
  assert.match(content ?? "", /text-only content slides/);
  assert.match(content ?? "", /visualChecked": true/);
  assert.match(
    content ?? "",
    /find \/workspace\/ppt-deck -type f -iname '\*\.pptx'/,
  );
  assert.match(
    bundledContent ?? "",
    /Color Dominance Rules|Color Palette Guidance/,
  );
  assert.match(bundledContent ?? "", /Chinese Typography Rules/);
  assert.match(bundledContent ?? "", /Topic-to-Visual Heuristics/);
  assert.match(bundledContent ?? "", /Misconception \/ Fix/);
  assert.match(bundledContent ?? "", /Framework Canvas/);
  assert.match(bundledContent ?? "", /Recap Matrix/);
  assert.doesNotMatch(bundledContent ?? "", /Page Number Badge.*MANDATORY/);
  assert.doesNotMatch(bundledContent ?? "", /Use ONLY the provided color palette/);
  assert.doesNotMatch(bundledContent ?? "", /Feynman Method/);
  assert.doesNotMatch(bundledContent ?? "", /Feynman learning method deck/);
  assert.doesNotMatch(bundledContent ?? "", /feynman-method\.pptx/);
  assert.doesNotMatch(bundledContent ?? "", /\/workspace\/work/);
  assert.doesNotMatch(
    bundledContent ?? "",
    /\/workspace\/output\/\.sourceweft\/artifacts\/slides\.json/,
  );
  assert.doesNotMatch(bundledContent ?? "", /Create one JS file per slide/);
  assert.doesNotMatch(bundledContent ?? "", /slides\/compile\.js/);
  assert.doesNotMatch(bundledContent ?? "", /slide-\d{2}\.js/);
  assert.doesNotMatch(bundledContent ?? "", /slide-XX-preview/);
});

test("ppt-deck builtin skill guards against unsafe natural-language literals", async () => {
  const skill = await getBuiltinSkillBySlug("ppt-deck");
  assert.ok(skill);
  const bundle = await loadBuiltinSkillBundle(skill.storagePointer);
  const content = bundle?.files.find(
    (file) => file.path === "SKILL.md",
  )?.contentText;

  assert.match(content ?? "", /Chinese text/);
  assert.match(content ?? "", /quotes/);
  assert.match(content ?? "", /multiline content/);
  assert.match(content ?? "", /Do not rely on a blacklist of bad phrases/);
  assert.match(
    content ?? "",
    /Guard the path from natural\s+language into executable code/,
  );
  assert.match(content ?? "", /If `node --check` fails twice/);
  assert.match(content ?? "", /Do not redesign slides during syntax repair/);
});

test("builtin skill bundles no longer include legacy skill.json", async () => {
  const skill = await getBuiltinSkillBySlug("feynman");
  assert.ok(skill);
  const bundle = await loadBuiltinSkillBundle(skill.storagePointer);

  assert.ok(bundle);
  assert.equal(
    bundle.files.some((file) => file.path === "skill.json"),
    false,
  );
});
