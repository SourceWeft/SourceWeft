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
    [
      "feynman",
      "image-generate",
      "meeting-summary",
      "ppt-deck",
      "video-presentation",
    ].map((slug) => bySlug.has(slug)),
    [true, true, true, true, true],
  );

  for (const slug of [
    "feynman",
    "image-generate",
    "meeting-summary",
    "ppt-deck",
    "video-presentation",
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
  // feynman is the market's `managed` (opt-in installable) builtin.
  assert.equal(bySlug.get("feynman")?.manifestJson.listing, "listed");
  assert.equal(bySlug.get("feynman")?.manifestJson.managed, true);
  assert.equal(existsSync(legacyBuiltinSkillsDir), false);
});

test("image-generate builtin skill exposes agent image artifact workflow without sandbox", async () => {
  const skill = await getBuiltinSkillBySlug("image-generate");

  assert.ok(skill);
  assert.equal(skill.visibility, "restricted");
  assert.equal(skill.manifestJson.visibility, "restricted");
  assert.equal(skill.manifestJson.slash, false);
  // Generators are listed in the market but always-on (not user-installable).
  assert.equal(skill.manifestJson.listing, "listed");
  assert.notEqual(skill.manifestJson.managed, true);
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
  assert.equal(
    skillServiceTestExports.isBuiltinSkillDefaultEnabled({
      slug: "video-presentation",
      visibility: "restricted",
    }),
    true,
  );
});

test("video-presentation builtin skill exposes agent video artifact workflow", async () => {
  const skill = await getBuiltinSkillBySlug("video-presentation");

  assert.ok(skill);
  assert.equal(skill.visibility, "restricted");
  assert.equal(skill.manifestJson.visibility, "restricted");
  assert.equal(skill.manifestJson.slash, false);
  assert.deepEqual(skill.manifestJson.tools, ["generate_video_presentation"]);
  assert.deepEqual(
    skill.manifestJson.options?.map((option) => ({
      id: option.id,
      target: option.target,
    })),
    [
      {
        id: "stylePreset",
        target: {
          toolName: "generate_video_presentation",
          path: "renderProfile.stylePreset",
        },
      },
      {
        id: "visualDensity",
        target: {
          toolName: "generate_video_presentation",
          path: "renderProfile.visualDensity",
        },
      },
      {
        id: "durationTarget",
        target: {
          toolName: "generate_video_presentation",
          path: "renderProfile.durationTarget",
        },
      },
      {
        id: "slideCount",
        target: {
          toolName: "generate_video_presentation",
          path: "slideCount",
        },
      },
      {
        id: "motionPacing",
        target: {
          toolName: "generate_video_presentation",
          path: "motion.pacing",
        },
      },
      {
        id: "canvasFps",
        target: {
          toolName: "generate_video_presentation",
          path: "canvas.fps",
        },
      },
      {
        id: "language",
        target: {
          toolName: "generate_video_presentation",
          path: "renderProfile.language",
        },
      },
      {
        id: "narrationEnabled",
        target: {
          toolName: "generate_video_presentation",
          path: "narration.enabled",
        },
      },
    ],
  );

  const bundle = await loadBuiltinSkillBundle(skill.storagePointer);
  const content = bundle?.files.find(
    (file) => file.path === "SKILL.md",
  )?.contentText;
  assert.match(content ?? "", /video_presentation/);
  assert.match(content ?? "", /generate_video_presentation/);
  assert.match(content ?? "", /brief-first/);
  assert.match(content ?? "", /browser preview\/export/);
  assert.match(content ?? "", /Do not call `publish_artifact`/);
  assert.doesNotMatch(content ?? "", /prepare_sandbox_workspace/);
  assert.match(content ?? "", /Do not describe it as a completed MP4/);
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
    "generate_image",
    "review_deck_visuals",
    "publish_artifact",
  ]);
  assert.deepEqual(
    skill.manifestJson.options?.map((option) => option.id),
    ["stylePreset", "visualDensity", "slideCount", "language"],
  );
  assert.deepEqual(skill.manifestJson.options?.[0]?.target, {
    path: "config.stylePreset",
  });
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

test("builtin skill bundles exclude build output and dependencies", async () => {
  // `.turbo/*.log` and `node_modules/.bin/*` (shell scripts) used to be walked
  // into the bundle: read as UTF-8, mounted under /skills/<name>/, and folded
  // into the bundle hash, so a turbo log write invalidated it. Skills are
  // re-read from disk every turn, so this was per-turn cost too.
  const skill = await getBuiltinSkillBySlug("ppt-deck");
  assert.ok(skill);
  const bundle = await loadBuiltinSkillBundle(skill.storagePointer);
  assert.ok(bundle);

  const leaked = bundle.files
    .map((file) => file.path)
    .filter(
      (filePath) =>
        filePath.startsWith("node_modules/") ||
        filePath.startsWith("dist/") ||
        filePath.split("/").some((segment) => segment.startsWith(".")),
    );

  assert.deepEqual(leaked, []);
  assert.ok(bundle.files.some((file) => file.path === "SKILL.md"));
  assert.ok(
    bundle.files.some((file) => file.path.startsWith("references/")),
  );
});
