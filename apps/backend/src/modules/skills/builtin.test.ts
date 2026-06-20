import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "vitest";
import {
  getBuiltinSkillBySlug,
  listBuiltinSkills,
  loadBuiltinSkillBundle,
} from "./builtin";
import { testExports as skillServiceTestExports } from "./service";

const legacyBuiltinSkillsDir = resolve(import.meta.dirname, "builtin");

test("builtin skills load from standalone capability packages", async () => {
  const skills = await listBuiltinSkills();
  const bySlug = new Map(skills.map((skill) => [skill.slug, skill]));

  assert.deepEqual(
    ["feynman", "image-generate", "meeting-summary", "ppt-deck"].map((slug) =>
      bySlug.has(slug),
    ),
    [true, true, true, true],
  );

  for (const slug of [
    "feynman",
    "image-generate",
    "meeting-summary",
    "ppt-deck",
  ]) {
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

test("image-generate builtin skill exposes agent image artifact workflow without sandbox", async () => {
  const skill = await getBuiltinSkillBySlug("image-generate");

  assert.ok(skill);
  assert.equal(skill.visibility, "restricted");
  assert.equal(skill.manifestJson.visibility, "restricted");
  assert.equal(skill.manifestJson.slash, false);
  assert.deepEqual(skill.manifestJson.tools, ["generate_image"]);
  assert.deepEqual(
    skill.manifestJson.options?.map((option) => ({
      id: option.id,
      target: option.target,
    })),
    [
      {
        id: "aspectRatio",
        target: { toolName: "generate_image", path: "config.aspectRatio" },
      },
      {
        id: "quality",
        target: { toolName: "generate_image", path: "config.quality" },
      },
      {
        id: "style",
        target: { toolName: "generate_image", path: "config.style" },
      },
    ],
  );

  const bundle = await loadBuiltinSkillBundle(skill.storagePointer);
  const content = bundle?.files.find(
    (file) => file.path === "SKILL.md",
  )?.contentText;
  assert.match(content ?? "", /generate/i);
  assert.match(content ?? "", /image artifact/i);
  assert.match(content ?? "", /generate_image/);
  assert.doesNotMatch(content ?? "", /费曼|Feynman/);
  assert.doesNotMatch(content ?? "", /For requests like|例如|比如/);
  assert.doesNotMatch(content ?? "", /\/workspace/);
  assert.doesNotMatch(content ?? "", /PIL|Pillow|Canvas/);
  assert.doesNotMatch(content ?? "", /HTML, SVG/);
  assert.doesNotMatch(content ?? "", /filesystem scripts/);
  assert.doesNotMatch(content ?? "", /code drawing as a substitute/);
  assert.doesNotMatch(content ?? "", /prepare_sandbox_workspace/);
  assert.doesNotMatch(content ?? "", /publish_artifact/);
});

test("restricted builtin artifact skills are default enabled", async () => {
  assert.equal(
    skillServiceTestExports.isBuiltinSkillDefaultEnabled({
      slug: "image-generate",
      visibility: "restricted",
    }),
    true,
  );
  assert.equal(
    skillServiceTestExports.isBuiltinSkillDefaultEnabled({
      slug: "ppt-deck",
      visibility: "restricted",
    }),
    true,
  );
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
    "publish_artifact",
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
  assert.doesNotMatch(content ?? "", /\/workfiles\/ppt-deck\/deck\.js/);
  assert.doesNotMatch(content ?? "", /\/workspace\/ppt-deck\/deck\.js/);
  assert.doesNotMatch(content ?? "", /SourceWeft Runtime Rules/);
  assert.doesNotMatch(content ?? "", /OUTPUT_DIR/);
  assert.match(content ?? "", /Quick Reference/);
  assert.match(content ?? "", /Read or analyze a PPTX/);
  assert.match(content ?? "", /Edit Existing Decks/);
  assert.match(content ?? "", /Create From Scratch/);
  assert.match(content ?? "", /Design Guardrails/);
  assert.match(content ?? "", /QA/);
  assert.match(content ?? "", /Dependencies/);
  assert.match(content ?? "", /prepared sandbox builder path/);
  assert.match(
    content ?? "",
    /prepare it into the\s+sandbox workspace according to the sandbox runtime rules/,
  );
  assert.doesNotMatch(content ?? "", /publish_artifact/);
  assert.doesNotMatch(content ?? "", /artifactType: "slides"/);
  assert.match(content ?? "", /PPTX_ARTIFACT_PATH/);
  assert.match(content ?? "", /PREVIEW_IMAGE_PATH/);
  assert.match(content ?? "", /\$QA_DIR\/preview\.jpg/);
  assert.doesNotMatch(content ?? "", /deckData/);
  assert.match(content ?? "", /promised visuals/);
  assert.doesNotMatch(content ?? "", /backgroundMode/);
  assert.doesNotMatch(content ?? "", /renderBackground/);
  assert.doesNotMatch(content ?? "", /applyBackground/);
  assert.doesNotMatch(content ?? "", /role\s*\/\s*visualIntent/);
  assert.doesNotMatch(content ?? "", /Feynman Method/);
  assert.doesNotMatch(content ?? "", /feynman-method\.pptx/);
  assert.doesNotMatch(content ?? "", /\/workspace\/ppt-deck\/qa/);
  assert.match(content ?? "", /QA_DIR="<sandbox QA directory>"/);
  assert.match(content ?? "", /Use the exact path printed by the deck builder/);
  assert.match(content ?? "", /===CONTENT_QA===/);
  assert.match(content ?? "", /===PPTX_TO_PDF===/);
  assert.match(content ?? "", /===PDF_TO_JPG===/);
  assert.match(content ?? "", /===VISUAL_QA_SUMMARY===/);
  assert.match(content ?? "", /pdftoppm/);
  assert.match(content ?? "", /QA_IMAGE_COUNT/);
  assert.match(content ?? "", /test "\$QA_IMAGE_COUNT" -gt 0/);
  assert.match(content ?? "", /PREVIEW_SOURCE_PATH="\$\(head -n 1 "\$QA_DIR\/slide-images\.txt"\)"/);
  assert.match(content ?? "", /echo "PREVIEW_IMAGE_PATH=\$QA_DIR\/preview\.jpg"/);
  assert.match(
    content ?? "",
    /find "\$QA_DIR" -maxdepth 1 -type f -name 'slide\*\.jpg' \| sort > "\$QA_DIR\/slide-images\.txt"/,
  );
  assert.match(content ?? "", /Do not run `file` against slide JPGs on the happy path/);
  assert.match(content ?? "", /use the\s+discovered slide image paths from `\$QA_DIR\/slide-images\.txt`/);
  assert.doesNotMatch(content ?? "", /\/workspace\/qa/);
  assert.match(content ?? "", /Do not assume a fixed filename such as `slide-01\.jpg`/);
  assert.match(content ?? "", /text-only content slides/);
  assert.match(content ?? "", /find "<sandbox task directory>" -type f -iname '\*\.pptx'/);
  assert.match(content ?? "", /roughly 12 visible tool calls/);
  assert.match(content ?? "", /roughly 18 visible tool calls/);
  assert.match(content ?? "", /If visible tool calls approach 20/);
  assert.doesNotMatch(content ?? "", /visible tool calls reach 20, stop/);
  assert.match(bundledContent ?? "", /===PPTX_TO_PDF===/);
  assert.match(bundledContent ?? "", /===PDF_TO_JPG===/);
  assert.match(bundledContent ?? "", /QA_IMAGE_COUNT/);
  assert.match(bundledContent ?? "", /PREVIEW_IMAGE_PATH/);
  assert.match(bundledContent ?? "", /visual QA summary/);
  assert.match(
    bundledContent ?? "",
    /Theme Presets/,
  );
  assert.match(bundledContent ?? "", /Learning Studio/);
  assert.match(bundledContent ?? "", /Executive Strategy/);
  assert.match(bundledContent ?? "", /Chinese or mixed Chinese-English decks/);
  assert.match(bundledContent ?? "", /Topic-to-Preset Map/);
  assert.match(bundledContent ?? "", /Concept Map/);
  assert.match(bundledContent ?? "", /Framework Canvas/);
  assert.match(bundledContent ?? "", /Recap Matrix/);
  assert.match(bundledContent ?? "", /sandbox-local scratch path/);
  assert.doesNotMatch(bundledContent ?? "", /Always write to `\/tmp\/` first/);
  assert.doesNotMatch(bundledContent ?? "", /\/workspace\/ppt-deck/);
  assert.doesNotMatch(bundledContent ?? "", /\/workfiles\/ppt-deck/);
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
  const content = bundle?.files
    .filter((file) => file.path.endsWith(".md"))
    .map((file) => file.contentText)
    .join("\n\n");

  assert.match(content ?? "", /long Chinese\/user text and quoted text/);
  assert.match(content ?? "", /quoted words/);
  assert.match(content ?? "", /DATA/);
  assert.match(content ?? "", /txt\(DATA/);
  assert.match(content ?? "", /visible curly quotes/);
  assert.match(content ?? "", /为什么“讲出来”能让你真正学会/);
  assert.match(content ?? "", /If `node --check` fails/);
  assert.match(content ?? "", /Do not redesign slides while repairing syntax/);
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
