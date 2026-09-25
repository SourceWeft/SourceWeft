import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import {
  collectSkillFiles,
  getBuiltinSkillBySlug,
  listBuiltinSkills,
  loadBuiltinSkillBundle,
} from "./builtin";

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
  assert.equal(skill.manifestJson.defaultEnabled, true);
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

test("video-presentation builtin skill exposes agent video artifact workflow", async () => {
  const skill = await getBuiltinSkillBySlug("video-presentation");

  assert.ok(skill);
  assert.equal(skill.visibility, "restricted");
  assert.equal(skill.manifestJson.visibility, "restricted");
  assert.equal(skill.manifestJson.defaultEnabled, false);
  assert.equal(skill.manifestJson.slash, false);
  assert.deepEqual(skill.manifestJson.tools, [
    "prepare_sandbox_workspace",
    "load_video_presentation",
    "generate_video_assets",
    "generate_video_narration",
    "validate_video_presentation",
    "publish_video_presentation",
  ]);
  assert.deepEqual(
    skill.manifestJson.options?.map((option) => ({
      id: option.id,
      target: option.target,
    })),
    [
      {
        id: "stylePreset",
        target: {
          path: "config.renderProfile.stylePreset",
        },
      },
      {
        id: "visualDensity",
        target: {
          path: "config.renderProfile.visualDensity",
        },
      },
      {
        id: "durationTarget",
        target: {
          path: "config.renderProfile.durationTarget",
        },
      },
      {
        id: "slideCount",
        target: {
          path: "config.slideCount",
        },
      },
      {
        id: "motionPacing",
        target: {
          path: "config.motion.pacing",
        },
      },
      {
        id: "canvasFps",
        target: {
          path: "config.canvas.fps",
        },
      },
      {
        id: "language",
        target: {
          path: "config.renderProfile.language",
        },
      },
      {
        id: "narrationEnabled",
        target: {
          path: "config.narration.enabled",
        },
      },
    ],
  );

  const bundle = await loadBuiltinSkillBundle(skill.storagePointer);
  const content = bundle?.files.find(
    (file) => file.path === "SKILL.md",
  )?.contentText;
  assert.match(content ?? "", /video_presentation/);
  assert.match(content ?? "", /publish_video_presentation/);
  assert.match(content ?? "", /root Agent/);
  assert.doesNotMatch(content ?? "", /built in the background/iu);
});

test("ppt-deck builtin skill stays hidden from the public gallery", async () => {
  const skill = await getBuiltinSkillBySlug("ppt-deck");

  assert.ok(skill);
  assert.equal(skill.visibility, "restricted");
  assert.equal(skill.manifestJson.visibility, "restricted");
  assert.equal(skill.manifestJson.defaultEnabled, true);
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
  assert.ok(bundle.files.some((file) => file.path.startsWith("references/")));
});

describe("builtin-files", () => {
  // A builtin skill package may ship what its scripts work with — fonts, images,
  // templates. Every file used to be read as UTF-8, which silently corrupts them.

  const sha = (bytes: Uint8Array | string) =>
    createHash("sha256").update(bytes).digest("hex");
  // Invalid UTF-8 plus NULs, like the head of a real TrueType file.
  const FONT = new Uint8Array([0x00, 0x01, 0x00, 0x00, 0xff, 0xfe, 0x80, 0x00]);

  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "builtin-skill-"));
    await mkdir(join(dir, "assets"));
    await writeFile(join(dir, "SKILL.md"), "---\nname: poster\n---\nBody\n");
    await writeFile(join(dir, "assets", "Inter.ttf"), FONT);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("text is text, a font is bytes, and both are hashed over what is on disk", async () => {
    const files = await collectSkillFiles(dir);
    const byPath = new Map(files.map((file) => [file.path, file]));

    const skillMd = byPath.get("SKILL.md")!;
    assert.equal(skillMd.isText, true);
    assert.equal(skillMd.mimeType, "text/markdown");
    assert.equal(skillMd.contentHash, sha("---\nname: poster\n---\nBody\n"));

    const font = byPath.get("assets/Inter.ttf")!;
    assert.equal(font.isText, false);
    assert.equal(font.contentText, null);
    assert.equal(font.mimeType, "font/ttf");
    assert.equal(font.sizeBytes, FONT.byteLength);
    assert.equal(font.contentHash, sha(FONT));
    assert.ok(font.isText === false);
    assert.deepEqual(new Uint8Array(await font.readBytes()), FONT);
  });

  test("a binary that changed on disk is hashed again, not answered from memory", async () => {
    const first = (await collectSkillFiles(dir)).find(
      (file) => file.path === "assets/Inter.ttf",
    )!;
    // Unchanged: same answer.
    const again = (await collectSkillFiles(dir)).find(
      (file) => file.path === "assets/Inter.ttf",
    )!;
    assert.equal(again.contentHash, first.contentHash);

    const replaced = new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x10, 0x80]);
    const path = join(dir, "assets", "Inter.ttf");
    await writeFile(path, replaced);
    const later = new Date(Date.now() + 5000);
    await utimes(path, later, later);

    const changed = (await collectSkillFiles(dir)).find(
      (file) => file.path === "assets/Inter.ttf",
    )!;
    assert.equal(changed.contentHash, sha(replaced));
    assert.equal(changed.sizeBytes, replaced.byteLength);
  });
});
