import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { capabilityManifestSchema } from "@sourceweft/capability-contracts";
import { getCapabilityContributions } from "@sourceweft/capability-runtime";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("sourceweft.capability.json parses as a valid video-presentation skill manifest", async () => {
  const rawManifest = await readFile(
    join(packageRoot, "sourceweft.capability.json"),
    "utf8",
  );
  const manifest = capabilityManifestSchema.parse(JSON.parse(rawManifest));
  const skill = getCapabilityContributions(manifest).skills[0];

  assert.equal(manifest.id, "sourceweft/video-presentation");
  assert.equal(skill?.id, "video-presentation");
});

test("skill bundle ships SKILL.md plus the progressive-disclosure references", async () => {
  const skillMd = await readFile(join(packageRoot, "SKILL.md"), "utf8");
  assert.match(skillMd, /^---\nname: video-presentation\n/u);
  assert.match(skillMd, /## Quick Reference/u);

  for (const reference of [
    "brief-guidelines.md",
    "narration-guidelines.md",
    "visual-quality.md",
    "style-gallery.md",
  ]) {
    const content = await readFile(
      join(packageRoot, "references", reference),
      "utf8",
    );
    assert.ok(content.trim().length > 200, `${reference} looks empty`);
    assert.match(
      skillMd,
      new RegExp(`references/${reference.replace(".", "\\.")}`, "u"),
      `SKILL.md does not link ${reference}`,
    );
  }
});
